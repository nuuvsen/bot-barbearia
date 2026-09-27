const express = require('express');
const cors = require('cors');
// =====================================================================
// 🔁 MIGRAÇÃO whatsapp-web.js -> Baileys (27/09/2026)
// -----------------------------------------------------------------------
// O whatsapp-web.js (e qualquer biblioteca baseada nele) abre um Chromium de verdade
// via Puppeteer só pra "fingir" ser um navegador rodando o WhatsApp Web. Nessa TV Box
// Armbian (787MB de RAM, 4 núcleos fracos), isso sozinho já consumia 300-450MB de RAM e
// boa parte da CPU, e ainda por cima esbarramos num bug conhecido e ainda aberto na
// própria biblioteca ("Execution context was destroyed" — ver commits anteriores) que
// não tinha correção definitiva.
// O Baileys (@whiskeysockets/baileys) não abre navegador nenhum: ele se conecta direto
// no WhatsApp via WebSocket, do mesmo jeito que o app oficial faz por baixo dos panos.
// Consumo de RAM cai de ~400MB pra ~30-50MB, e o bug do Puppeteer deixa de existir por
// completo (não tem mais Chromium pra travar/crashar). É uma sessão NOVA — precisa
// escanear o QR de novo, a sessão antiga do whatsapp-web.js não é compatível.
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
// firebase.js exporta o Firestore direto (module.exports = db), não como { db } —
// desestruturar aqui deixava "db" undefined e quebrava toda chamada db.collection(...).
const db = require('./firebase');
const cron = require('node-cron');
// firebase.js (acima) já chama admin.initializeApp(...) antes desta linha rodar — como o
// require do Node é cacheado, isto aqui pega o MESMO app já inicializado, só que agora
// também dá acesso a admin.messaging() (notificações push), que db (só o Firestore) não tem.
const admin = require('firebase-admin');

const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

let currentQrUrl = null;
let botStatus = 'desconectado';
const estadosUsuarios = {};

// Função de pausa (delay) global para Anti-Ban
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// =====================================================================
// 🔔 NOTIFICAÇÕES PUSH (Firebase Cloud Messaging)
// =====================================================================
// Reaproveitada tanto pela rota /api/notificacoes/enviar (chamada pelo frontend) quanto
// internamente pelos cron jobs e pela lista de espera abaixo. destino é 'cliente' (usa
// identificador = telefone, doc direto em "clientes"), 'barbeiro' (identificador = nome,
// busca em "barbeiros" por nome — pode achar mais de um documento) ou 'todos-barbeiros'
// (manda pra todo mundo cadastrado em "barbeiros", ignora identificador).
async function enviarPush({ destino, identificador, titulo, corpo }) {
    if (!titulo || !corpo) return { enviados: 0, erro: 'titulo e corpo são obrigatórios' };

    try {
        let tokens = [];
        const refsParaLimpar = []; // [{ ref, tokens }] — pra remover token inválido/expirado depois

        if (destino === 'cliente') {
            if (!identificador) return { enviados: 0, erro: 'identificador (telefone) é obrigatório' };
            const snap = await db.collection('clientes').doc(identificador).get();
            if (snap.exists) {
                const t = snap.data().fcmTokens || [];
                tokens.push(...t);
                refsParaLimpar.push({ ref: snap.ref, tokens: t });
            }
        } else if (destino === 'barbeiro') {
            if (!identificador) return { enviados: 0, erro: 'identificador (nome do barbeiro) é obrigatório' };
            const snap = await db.collection('barbeiros').where('nome', '==', identificador).get();
            snap.forEach(doc => {
                const t = doc.data().fcmTokens || [];
                tokens.push(...t);
                refsParaLimpar.push({ ref: doc.ref, tokens: t });
            });
        } else if (destino === 'todos-barbeiros') {
            const snap = await db.collection('barbeiros').get();
            snap.forEach(doc => {
                const t = doc.data().fcmTokens || [];
                tokens.push(...t);
                refsParaLimpar.push({ ref: doc.ref, tokens: t });
            });
        } else {
            return { enviados: 0, erro: 'destino inválido' };
        }

        tokens = [...new Set(tokens)];
        if (tokens.length === 0) {
            return { enviados: 0, aviso: 'Ninguém com notificações ativadas para esse destino.' };
        }

        const resposta = await admin.messaging().sendEachForMulticast({
            tokens,
            notification: { title: titulo, body: corpo }
        });

        // Limpa tokens inválidos/expirados (app desinstalado, permissão revogada, etc.) pra
        // não ficar tentando mandar pra eles pra sempre.
        const tokensInvalidos = [];
        resposta.responses.forEach((r, i) => {
            const codigo = r.error?.code || '';
            if (!r.success && (codigo.includes('registration-token-not-registered') || codigo.includes('invalid-argument'))) {
                tokensInvalidos.push(tokens[i]);
            }
        });

        if (tokensInvalidos.length > 0) {
            for (const { ref, tokens: tokensDoDoc } of refsParaLimpar) {
                const restantes = tokensDoDoc.filter(t => !tokensInvalidos.includes(t));
                if (restantes.length !== tokensDoDoc.length) {
                    await ref.update({ fcmTokens: restantes });
                }
            }
        }

        console.log(`🔔 Push "${titulo}" -> ${destino}${identificador ? ' (' + identificador + ')' : ''}: ${resposta.successCount}/${tokens.length} entregues.`);
        return { enviados: resposta.successCount };
    } catch (erro) {
        console.error('❌ Erro ao enviar notificação push:', erro);
        return { enviados: 0, erro: 'Erro ao enviar notificação.' };
    }
}

// ==========================================
// ⚙️ CONFIGURAÇÕES DINÂMICAS DO PAINEL
// ==========================================
let botConfig = {
    lembretesAtivos: true,
    horarios: ['09:00', '18:00'],
    msgConfirmacao: '✅ *Olá, {nome}!* Seu agendamento foi confirmado com sucesso!\n\n✂️ *Serviço:* {servico}\n📅 *Data:* {data}\n⏰ *Horário:* {hora}\n💈 *Profissional:* {barbeiro}\n\nTe esperamos na Barbearia Antunes!',
    msgLembrete: '⏰ *Olá, {nome}!* Passando para lembrar do seu agendamento hoje às *{hora}* na Barbearia Antunes.\n\nCaso não possa comparecer, responda *Menu* e selecione cancelar.',

    // Configurações do Radar
    radarAtivo: false,
    radarDias: 45,
    msgRadar: 'Fala {nome}, sumido! Já faz uns dias desde o seu último trato no visual. Que tal agendar um horário essa semana na Barbearia Antunes?',

    // ⭐ NOVAS CONFIGURAÇÕES NPS ⭐
    npsAtivo: true,
    npsTempoMinutos: 30, // Tempo configurável em minutos
    msgNPS: 'Olá, {nome}! Esperamos que tenha curtido o seu visual hoje na Barbearia Antunes. ✂️\n\nComo foi o seu atendimento com o profissional *{barbeiro}*?\n\nResponda a esta mensagem com uma nota de *1 a 5* ⭐ para nos ajudar a manter a qualidade lá em cima!',

    // 🕐 LISTA DE ESPERA — enviada pelo modo "bot" (ver bloqueioUtils.js liberarHorario no
    // frontend) quando um horário vaga e o primeiro da fila é chamado pra confirmar.
    msgListaEspera: '🎉 *Boa notícia, {nome}!* Um horário vagou na Barbearia Antunes e você é o próximo da lista de espera!\n\n✂️ *Serviço:* {servico}\n📅 *Data:* {data}\n⏰ *Horário:* {hora}\n💈 *Profissional:* {barbeiro}\n\nVocê ainda quer esse horário?\n\n*1* - Sim, quero!\n*2* - Não, obrigado'
};

// Fica escutando as mudanças feitas lá no site em tempo real
db.collection('configuracoes').doc('botWhatsApp').onSnapshot((doc) => {
    if (doc.exists) {
        botConfig = { ...botConfig, ...doc.data() };
        console.log('⚙️ Novas configurações do painel aplicadas com sucesso!');
    }
});

// ==========================================

async function testarConexaoFirebase() {
    try {
        await db.collection('configuracoes').limit(1).get();
        console.log('✅ Firebase conectado com sucesso!');
    } catch (error) {
        console.error('❌ Erro ao conectar no Firebase:', error);
    }
}
testarConexaoFirebase();

// =====================================================================
// 📡 CONEXÃO COM O WHATSAPP (Baileys)
// =====================================================================
// "sock" é reatribuído a cada (re)conexão — nunca guarde uma referência antiga em outra
// variável, sempre acesse via "sock" na hora de usar (é assim que o Reiniciar Bot e a
// reconexão automática conseguem trocar a conexão por baixo sem quebrar o resto do código.
let sock = null;
let reiniciandoBot = false;

async function iniciarSock() {
    // Sessão persistida em disco (equivalente ao LocalAuth do whatsapp-web.js), num volume
    // Docker próprio — pasta nova porque a sessão antiga (.wwebjs_auth) é de outra
    // biblioteca e não é compatível.
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'baileys_auth'));
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        // Baileys por padrão loga bastante coisa técnica (pacotes, handshake, etc.) — silenciamos,
        // já temos nossos próprios console.log nos pontos que importam pro painel/operação.
        logger: pino({ level: 'silent' }),
        // Nome que aparece em "Aparelhos Conectados" no WhatsApp do celular.
        browser: ['Barbearia Antunes', 'Chrome', '120.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR Code recebido. Aguardando leitura...');
            botStatus = 'aguardando_qr';
            qrcode.toDataURL(qr)
                .then(url => { currentQrUrl = url; })
                .catch(erro => console.error('Erro ao gerar imagem do QR Code:', erro));
        }

        if (connection === 'open') {
            console.log('Bot conectado ao WhatsApp e pronto!');
            botStatus = 'conectado';
            currentQrUrl = null;
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const foiLogout = statusCode === DisconnectReason.loggedOut;
            console.log('Bot desconectado. Motivo:', statusCode || lastDisconnect?.error?.message || 'desconhecido');
            botStatus = 'desconectado';
            currentQrUrl = null;

            // Se foi um "Reiniciar Bot" manual (painel admin), quem cuida de chamar
            // iniciarSock() de novo é a própria rota /api/bot/reiniciar — não faz duplicado aqui.
            if (reiniciandoBot) return;

            // "loggedOut" é quando o usuário removeu o aparelho pelo celular (WhatsApp > Aparelhos
            // Conectados > Sair) — nesse caso a sessão salva não serve mais, mas ainda vale a pena
            // tentar de novo: o Baileys já gera um QR Code novo sozinho quando as credenciais salvas
            // não são mais válidas.
            console.log('🔁 Tentando reconectar automaticamente' + (foiLogout ? ' (sessão encerrada, será necessário escanear um novo QR)' : '') + '...');
            iniciarSock().catch(erro => console.error('❌ Erro ao tentar reconectar:', erro));
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // "notify" = mensagem nova de verdade. Outros tipos (ex: "append") aparecem durante a
        // sincronização do histórico logo após conectar — não são mensagens novas do usuário.
        if (type !== 'notify') return;

        const msg = messages[0];
        if (!msg || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return;

        const texto = extrairTexto(msg);
        if (!texto) return; // mensagem sem texto (figurinha, reação, etc.) — nada a processar

        try {
            await processarMensagem(msg, remoteJid, texto);
        } catch (erro) {
            console.error('❌ Erro inesperado ao processar mensagem:', erro);
        }
    });

    return sock;
}

// Extrai o texto de uma mensagem do Baileys, desembrulhando mensagens efêmeras
// ("apagar após X tempo") quando necessário. Cobre os tipos de mensagem que interessam
// pro bot (texto simples, texto com formatação/link, legenda de foto/vídeo).
function extrairTexto(msg) {
    let conteudo = msg.message;
    if (!conteudo) return '';
    if (conteudo.ephemeralMessage) conteudo = conteudo.ephemeralMessage.message;
    if (!conteudo) return '';

    return conteudo.conversation
        || conteudo.extendedTextMessage?.text
        || conteudo.imageMessage?.caption
        || conteudo.videoMessage?.caption
        || '';
}

// Confirma se um número tem WhatsApp ativo e devolve o JID pra usar em sendMessage —
// equivalente ao client.getNumberId(...)._serialized do whatsapp-web.js.
async function obterJidValido(numeroPuro) {
    if (!sock) return null;
    try {
        const resultados = await sock.onWhatsApp(numeroPuro);
        const encontrado = resultados && resultados[0];
        return (encontrado && encontrado.exists) ? encontrado.jid : null;
    } catch (erro) {
        console.error('Erro ao verificar número no WhatsApp:', erro.message);
        return null;
    }
}

// Atalho pra mandar texto simples — equivalente ao client.sendMessage(chatId, texto).
async function enviarMensagem(jid, texto) {
    return sock.sendMessage(jid, { text: texto });
}

function limparNumeroDigitado(texto) {
    return texto.replace(/\D/g, '');
}

function obterVariacoesTelefone(numeroPuro) {
    let num = numeroPuro.startsWith('55') ? numeroPuro.substring(2) : numeroPuro;
    let numCom9 = num;
    let numSem9 = num;

    if (num.length === 11) {
        numSem9 = num.substring(0, 2) + num.substring(3);
    } else if (num.length === 10) {
        numCom9 = num.substring(0, 2) + '9' + num.substring(2);
    }

    return [numCom9, numSem9, Number(numCom9), Number(numSem9)];
}

// ==========================================
// 🕐 LISTA DE ESPERA (espelha bloqueioUtils.js do frontend, em versão Node/admin-SDK) — só
// entra em ação quando o candidato chamado pelo bot RECUSA o horário (responde "2"): aí
// precisa passar a vaga pro próximo da fila sem precisar de outra ida-e-volta pelo frontend,
// já que quem está "ao vivo" nesse momento é o backend do bot, não o navegador de ninguém.
// ==========================================
function gerarIdTravaHorario(barbeiro, data, hora) {
    return `${String(barbeiro).replace(/\//g, '-')}_${data}_${hora}`;
}

async function buscarProximoCandidato(barbeiro, data) {
    const [snapEspecifico, snapQualquer] = await Promise.all([
        db.collection('listaEspera').where('barbeiro', '==', barbeiro).where('data', '==', data).where('status', '==', 'Aguardando').get(),
        db.collection('listaEspera').where('barbeiro', '==', 'qualquer').where('data', '==', data).where('status', '==', 'Aguardando').get()
    ]);
    const candidatos = [...snapEspecifico.docs, ...snapQualquer.docs].map(d => ({ id: d.id, ...d.data() }));
    candidatos.sort((a, b) => new Date(a.criadoEm) - new Date(b.criadoEm));
    return candidatos[0] || null;
}

// Chamada quando o candidato atual recusa (ou não conseguimos localizá-lo no WhatsApp). Se
// houver mais alguém na fila, transfere a trava pro próximo (nunca apaga no meio do caminho —
// mesmo princípio do liberarHorario do frontend) e já dispara a pergunta pra ele também. Se a
// fila acabou, libera o horário de vez.
async function tentarProximoDaFila(barbeiro, data, hora) {
    try {
        const candidato = await buscarProximoCandidato(barbeiro, data);

        if (!candidato) {
            await db.collection('travasHorario').doc(gerarIdTravaHorario(barbeiro, data, hora)).delete();
            return;
        }

        const travaRef = db.collection('travasHorario').doc(gerarIdTravaHorario(barbeiro, data, hora));
        const novoDocRef = db.collection('agendamentos').doc();

        await db.runTransaction(async (transaction) => {
            transaction.set(novoDocRef, {
                clienteNome: candidato.nome,
                clienteTelefone: candidato.telefone,
                barbeiro,
                servico: candidato.servico || 'A combinar',
                preco: 'A combinar',
                data,
                hora,
                status: 'Aguardando Confirmação',
                origemListaEspera: true,
                listaEsperaId: candidato.id
            });
            transaction.set(travaRef, {
                barbeiro, data, hora,
                colecao: 'agendamentos',
                agendamentoId: novoDocRef.id,
                criadoEm: new Date().toISOString()
            });
        });

        await db.collection('listaEspera').doc(candidato.id).update({
            status: 'Notificado',
            horaOferecida: hora,
            notificadoEm: new Date().toISOString()
        });

        try {
            let numeroPuro = String(candidato.telefone).replace(/\D/g, '');
            if (!numeroPuro.startsWith('55')) numeroPuro = '55' + numeroPuro;
            const jidValido = await obterJidValido(numeroPuro);

            if (jidValido) {
                const primeiroNome = candidato.nome ? candidato.nome.split(' ')[0] : 'Cliente';
                const [ano, mes, dia] = String(data || '').split('-');
                const dataFormatada = (ano && mes && dia) ? `${dia}/${mes}/${ano}` : data;

                let mensagem = botConfig.msgListaEspera
                    .replace(/{nome}/g, primeiroNome)
                    .replace(/{servico}/g, candidato.servico || 'seu serviço')
                    .replace(/{data}/g, dataFormatada)
                    .replace(/{hora}/g, hora)
                    .replace(/{barbeiro}/g, barbeiro);

                await enviarMensagem(jidValido, mensagem);

                estadosUsuarios[numeroPuro] = {
                    etapa: 'aguardando_confirmacao_espera',
                    clienteData: estadosUsuarios[numeroPuro]?.clienteData || null,
                    dadosTemporarios: {
                        telefone: candidato.telefone,
                        nomeCliente: candidato.nome,
                        servico: candidato.servico,
                        data,
                        horario: hora,
                        barbeiro,
                        listaEsperaId: candidato.id,
                        agendamentoId: novoDocRef.id
                    }
                };
                console.log(`✅ [Lista de Espera] Próximo da fila avisado: ${primeiroNome}`);
            } else {
                console.log(`⚠️ [Lista de Espera] WhatsApp não reconheceu o número do próximo candidato (${candidato.telefone}), passando pro seguinte.`);
                await db.collection('listaEspera').doc(candidato.id).update({ status: 'Recusado' });
                await tentarProximoDaFila(barbeiro, data, hora);
            }
        } catch (errBot) {
            console.error('❌ Erro ao avisar o próximo candidato da fila:', errBot);
        }
    } catch (error) {
        console.error('❌ Erro ao tentar passar a vaga pro próximo da fila:', error);
    }
}

// =====================================================================
// 💬 PROCESSAMENTO DE MENSAGEM RECEBIDA (estado por número — mesma lógica de antes, só
// trocando a leitura/resposta da mensagem pro formato do Baileys)
// =====================================================================
async function processarMensagem(msg, remoteJid, textoOriginal) {
    // Ajuda a responder direto no chat de quem mandou, citando a mensagem original —
    // equivalente ao msg.reply(...) do whatsapp-web.js.
    const responder = (texto) => sock.sendMessage(remoteJid, { text: texto }, { quoted: msg });

    let texto = textoOriginal.toLowerCase().trim();
    // Prefere o número de telefone "real" quando o WhatsApp usa um JID @lid (identidade
    // alternativa de privacidade) pro remetente — remoteJidAlt costuma trazer o @s.whatsapp.net
    // correspondente nesses casos. Sem isso, cai pro remoteJid normal.
    const jidPreferido = (msg.key.remoteJidAlt && msg.key.remoteJidAlt.endsWith('@s.whatsapp.net'))
        ? msg.key.remoteJidAlt
        : remoteJid;
    const numeroClienteWpp = jidPreferido.split('@')[0];

    if (!estadosUsuarios[numeroClienteWpp]) {
        estadosUsuarios[numeroClienteWpp] = { etapa: 'verificando_identidade', clienteData: null, dadosTemporarios: null };
    }

    const estadoAtual = estadosUsuarios[numeroClienteWpp];

    if (estadoAtual.etapa === 'verificando_identidade') {
        try {
            const snapshotID = await db.collection('clientes').where('whatsappId', '==', numeroClienteWpp).get();

            if (!snapshotID.empty) {
                let clienteDoc = null;
                snapshotID.forEach(doc => {
                    clienteDoc = { id: doc.id, ...doc.data() };
                });

                estadoAtual.clienteData = clienteDoc;
                estadoAtual.etapa = 'menu';
            } else {
                estadoAtual.etapa = 'perguntando_se_cliente';
                await responder(`*Olá! Bem-vindo à Barbearia Antunes!* 💈\n\nIdentificamos que este é o seu primeiro contato por este canal.\n\n*Você já possui cadastro no nosso site de agendamentos?*\n\nDigite o número da opção:\n*1️⃣* - Sim, já sou cliente\n*2️⃣* - Não, quero conhecer/agendar`);
                return;
            }
        } catch (error) {
            console.error('Erro na verificação de identidade:', error);
            estadoAtual.etapa = 'menu';
        }
    }

    // ==========================================
    // ⭐ CAPTURA DA NOTA DO NPS
    // ==========================================
    if (estadoAtual.etapa === 'aguardando_nps') {
        const nota = parseInt(texto); // Tenta converter o que ele digitou em número

        // Verifica se é uma nota válida entre 1 e 5
        if (!isNaN(nota) && nota >= 1 && nota <= 5) {
            try {
                const barbeiroAvaliado = estadoAtual.dadosTemporarios.barbeiro;
                const nomeClienteAvaliado = estadoAtual.dadosTemporarios.nomeCliente;

                // Salva a nota no Firebase já de cara, na coleção "avaliacoes" — não fica
                // esperando o comentário (pedido logo abaixo) pra contar no painel/alerta,
                // já que o cliente pode nunca responder esse segundo passo. "lida: false"
                // é o que alimenta o alerta/badge de avaliação ruim no painel admin.
                const avaliacaoRef = await db.collection('avaliacoes').add({
                    nota: nota,
                    barbeiro: barbeiroAvaliado,
                    clienteNome: nomeClienteAvaliado,
                    telefone: numeroClienteWpp,
                    comentario: null,
                    lida: false,
                    data: new Date().toISOString()
                });

                // Pede um comentário na sequência (sempre opcional) — com um texto mais
                // empático quando a nota é ruim (1 ou 2), já que é quando o "porquê" mais
                // importa pra dar um retorno de verdade ao cliente.
                if (nota <= 2) {
                    await responder('Poxa, sentimos muito que não tenha sido uma boa experiência. 😕 Pode nos contar o que aconteceu? Isso nos ajuda a corrigir e te atender melhor da próxima vez.\n\n_(Se preferir não comentar, responda *pular*)_');
                } else {
                    await responder('Muito obrigado pela nota! 🙏 Quer deixar um comentário sobre o atendimento?\n\n_(Se não quiser comentar, responda *pular*)_');
                }

                estadoAtual.etapa = 'aguardando_comentario_nps';
                estadoAtual.dadosTemporarios = { avaliacaoId: avaliacaoRef.id, nota };
            } catch (error) {
                console.error('Erro ao salvar avaliação:', error);
            }
        } else {
            await responder('⚠️ Por favor, digite apenas um número de *1 a 5* para avaliar o seu atendimento:');
        }
        return; // Para a execução aqui
    }

    // ==========================================
    // 💬 CAPTURA DO COMENTÁRIO OPCIONAL DO NPS (roda logo depois da nota, bloco acima)
    // ==========================================
    if (estadoAtual.etapa === 'aguardando_comentario_nps') {
        const pulou = ['pular', 'não', 'nao', 'n', 'não quero', 'sem comentario', 'sem comentário'].includes(texto);

        try {
            if (!pulou && estadoAtual.dadosTemporarios?.avaliacaoId) {
                // textoOriginal (não "texto", que está em lowercase/trim) preserva o comentário
                // exatamente como o cliente escreveu — maiúsculas, acentos e pontuação.
                await db.collection('avaliacoes').doc(estadoAtual.dadosTemporarios.avaliacaoId).update({
                    comentario: textoOriginal.trim()
                });
            }
            await responder(pulou
                ? 'Tudo bem! Obrigado novamente pela nota. 🙏'
                : 'Muito obrigado pelo retorno! Isso nos ajuda a manter o padrão Antunes de qualidade. 🙌');
        } catch (error) {
            console.error('Erro ao salvar comentário da avaliação:', error);
        } finally {
            estadoAtual.etapa = 'menu';
            estadoAtual.dadosTemporarios = null;
        }
        return;
    }

    // ==========================================
    // ⏳ RESPOSTA DA LISTA DE ESPERA (SIM/NÃO) — estado empurrado direto pelo backend em
    // /api/bot/lista-espera ou por tentarProximoDaFila(), nunca pelo próprio fluxo de menu.
    // ==========================================
    if (estadoAtual.etapa === 'aguardando_confirmacao_espera') {
        const dadosEspera = estadoAtual.dadosTemporarios;

        if (texto === '1' || texto === 'sim') {
            try {
                if (dadosEspera?.agendamentoId) {
                    await db.collection('agendamentos').doc(dadosEspera.agendamentoId).update({ status: 'Pendente' });
                }
                if (dadosEspera?.listaEsperaId) {
                    await db.collection('listaEspera').doc(dadosEspera.listaEsperaId).update({ status: 'Atendido' });
                }

                const primeiroNome = dadosEspera?.nomeCliente ? dadosEspera.nomeCliente.split(' ')[0] : 'Cliente';
                const [ano, mes, dia] = String(dadosEspera?.data || '').split('-');
                const dataFormatada = (ano && mes && dia) ? `${dia}/${mes}/${ano}` : dadosEspera?.data;

                let mensagem = botConfig.msgConfirmacao
                    .replace(/{nome}/g, primeiroNome)
                    .replace(/{servico}/g, dadosEspera?.servico || 'seu serviço')
                    .replace(/{data}/g, dataFormatada || '')
                    .replace(/{hora}/g, dadosEspera?.horario || '')
                    .replace(/{barbeiro}/g, dadosEspera?.barbeiro || '');
                await responder(mensagem);

                console.log(`✅ [Lista de Espera] ${primeiroNome} confirmou o horário.`);
                estadoAtual.etapa = 'menu';
                estadoAtual.dadosTemporarios = null;
            } catch (error) {
                console.error('❌ Erro ao confirmar horário da lista de espera:', error);
                await responder('❌ Houve um erro ao confirmar seu horário. Por favor, entre em contato com a barbearia.');
            }
            return;
        }

        if (texto === '2' || texto === 'não' || texto === 'nao') {
            try {
                if (dadosEspera?.agendamentoId) {
                    await db.collection('agendamentos').doc(dadosEspera.agendamentoId).delete();
                }
                if (dadosEspera?.listaEsperaId) {
                    await db.collection('listaEspera').doc(dadosEspera.listaEsperaId).update({ status: 'Recusado' });
                }

                await responder('Tudo bem! Você foi removido da lista de espera para esse horário. Obrigado pela paciência! 🙏');

                estadoAtual.etapa = 'menu';
                estadoAtual.dadosTemporarios = null;

                if (dadosEspera?.barbeiro && dadosEspera?.data && dadosEspera?.horario) {
                    await tentarProximoDaFila(dadosEspera.barbeiro, dadosEspera.data, dadosEspera.horario);
                }
            } catch (error) {
                console.error('❌ Erro ao recusar horário da lista de espera:', error);
            }
            return;
        }

        await responder('⚠️ Por favor, responda *1* para confirmar o horário ou *2* para recusar:');
        return;
    }

    if (estadoAtual.etapa === 'perguntando_se_cliente') {
        if (texto === '1' || texto === 'sim') {
            estadoAtual.etapa = 'aguardando_numero_registro';
            await responder('Perfeito! Para que eu possa localizar o seu perfil, por favor *digite o seu número de telefone com DDD* (ex: 53999999999), apenas os números:');
            return;
        } else if (texto === '2' || texto === 'não' || texto === 'nao') {
            estadoAtual.etapa = 'onboarding_finalizado_visitante';
            await responder('Seja muito bem-vindo! Você pode realizar o seu agendamento escolhendo os melhores profissionais e horários diretamente no nosso site: http://localhost:3000 \n\nCaso precise de suporte humano, digite *3* para falar com o barbeiro.');
            return;
        } else {
            await responder('Por favor, responda apenas:\n*1* - Se você já possui cadastro\n*2* - Se você ainda não possui cadastro');
            return;
        }
    }

    if (estadoAtual.etapa === 'aguardando_numero_registro') {
        const numeroLimpo = limparNumeroDigitado(texto);

        if (numeroLimpo.length < 10 || numeroLimpo.length > 11) {
            await responder('⚠️ O número digitado parece inválido. Certifique-se de incluir o DDD e o número completo (ex: 53997102442). Digite novamente:');
            return;
        }

        try {
            const variacoesBusca = obterVariacoesTelefone(numeroLimpo);
            const clienteSnapshot = await db.collection('clientes').where('telefone', 'in', variacoesBusca).get();

            if (clienteSnapshot.empty) {
                await responder('❌ Não encontramos nenhum cadastro com esse número no nosso sistema.\n\nPor favor, confira o número e digite novamente ou digite *Menu* para reiniciar.');
                return;
            }

            let docIdCliente = null;
            let dadosCliente = null;
            clienteSnapshot.forEach(doc => {
                docIdCliente = doc.id;
                dadosCliente = doc.data();
            });

            await db.collection('clientes').doc(docIdCliente).update({
                whatsappId: numeroClienteWpp
            });

            estadoAtual.clienteData = { id: docIdCliente, ...dadosCliente, whatsappId: numeroClienteWpp };
            estadoAtual.etapa = 'menu';

            // Força a queda no bloco de menu logo abaixo nesta mesma mensagem, igual o
            // fluxo original fazia — a condição do menu já cobre isso via estadoAtual.etapa,
            // mas mantemos "texto" também setado por clareza.
            texto = 'menu';
        } catch (error) {
            console.error('Erro ao vincular ID do cliente:', error);
            await responder('Ocorreu um erro interno ao salvar seus dados. Digite o número novamente para tentar o vínculo:');
            return;
        }
    }

    if (estadoAtual.etapa === 'onboarding_finalizado_visitante') {
        if (texto === '3') {
            await responder('Um momento, por favor. O barbeiro foi notificado e irá responder assim que possível. ⏳');
        } else {
            estadoAtual.etapa = 'verificando_identidade';
            texto = 'menu';
        }
        return;
    }

    const clienteLogado = estadoAtual.clienteData;
    const telefonesBuscaAgendamento = obterVariacoesTelefone(clienteLogado.telefone.toString());

    if (texto === 'oi' || texto === 'olá' || texto === 'ola' || texto === 'menu' || (estadoAtual.etapa === 'menu' && !['1', '2', '3'].includes(texto))) {
        estadoAtual.etapa = 'menu';
        estadoAtual.dadosTemporarios = null;

        try {
            const primeiroNome = clienteLogado.nome ? clienteLogado.nome.split(' ')[0] : 'Cliente';

            const agendaSnapshot = await db.collection('agendamentos').where('clienteTelefone', 'in', telefonesBuscaAgendamento).get();

            let resumoAgendamento = '\nVocê não possui agendamentos marcados no momento. ❌';
            if (!agendaSnapshot.empty) {
                const proximos = [];
                agendaSnapshot.forEach(doc => proximos.push(doc.data()));
                resumoAgendamento = `\n📅 *Seu próximo agendamento:* ${proximos[0].data} às ${proximos[0].horario || proximos[0].hora} (${proximos[0].servico.nome || proximos[0].servico}).`;
            }

            await responder(`*Olá, ${primeiroNome}!* Bem-vindo de volta à Barbearia Antunes! 💈${resumoAgendamento}\n\nComo posso ajudar hoje? Digite o número da opção:\n\n*1️⃣* - Detalhar meus agendamentos\n*2️⃣* - Cancelar um agendamento\n*3️⃣* - Falar com o barbeiro`);

        } catch (error) {
            console.error('Erro no menu principal:', error);
            await responder('❌ Erro ao carregar os dados da agenda. Digite "Menu" para tentar novamente.');
        }
        return;
    }

    if (estadoAtual.etapa === 'menu') {
        if (texto === '1') {
            await responder('⏳ Buscando detalhes dos seus horários...');
            try {
                const snapshot = await db.collection('agendamentos').where('clienteTelefone', 'in', telefonesBuscaAgendamento).get();

                if (snapshot.empty) {
                    await responder('Você não possui nenhum agendamento registrado.');
                    return;
                }

                let msgAgendamentos = '*Seus Agendamentos Cadastrados:* 📅\n\n';
                snapshot.forEach(doc => {
                    const agenda = doc.data();
                    msgAgendamentos += `✂️ *Serviço:* ${agenda.servico.nome || agenda.servico}\n`;
                    msgAgendamentos += `🕒 *Data/Hora:* ${agenda.data} às ${agenda.horario || agenda.hora}\n`;
                    msgAgendamentos += `💈 *Barbeiro:* ${agenda.barbeiro.nome || agenda.barbeiro}\n\n`;
                });

                await responder(msgAgendamentos);
            } catch (error) {
                console.error('Erro ao detalhar horários:', error);
                await responder('Erro ao buscar os agendamentos.');
            }
            return;
        }

        if (texto === '2') {
            try {
                const snapshot = await db.collection('agendamentos').where('clienteTelefone', 'in', telefonesBuscaAgendamento).get();

                if (snapshot.empty) {
                    await responder('Você não possui agendamentos ativos para cancelar.');
                    return;
                }

                let listaCancelamento = '*Qual agendamento você deseja CANCELAR?* ⚠️\n\nDigite o número correspondente:\n\n';
                const agendamentosEncontrados = [];
                let index = 1;

                snapshot.forEach(doc => {
                    const agenda = doc.data();
                    agendamentosEncontrados.push({ id: doc.id, ...agenda });
                    listaCancelamento += `*${index}* - ${agenda.data} às ${agenda.horario || agenda.hora} | ${agenda.servico.nome || agenda.servico}\n`;
                    index++;
                });

                listaCancelamento += '\n*0* - Voltar ao Menu Principal';

                estadoAtual.etapa = 'aguardando_selecao_cancelamento';
                estadoAtual.dadosTemporarios = agendamentosEncontrados;

                await responder(listaCancelamento);
            } catch (error) {
                console.error('Erro ao listar para cancelamento:', error);
                await responder('Erro ao carregar lista de cancelamento.');
            }
            return;
        }

        if (texto === '3') {
            await responder('Um momento, por favor. O barbeiro foi notificado e irá responder assim que possível. ⏳');
            return;
        }
    }

    if (estadoAtual.etapa === 'aguardando_selecao_cancelamento') {
        if (texto === '0') {
            estadoAtual.etapa = 'menu';
            estadoAtual.dadosTemporarios = null;
            await responder('Operação cancelada. Digite "Menu" para retornar.');
            return;
        }

        const escolhaIndex = parseInt(texto) - 1;
        const agendamentosDisponiveis = estadoAtual.dadosTemporarios;

        if (isNaN(escolhaIndex) || escolhaIndex < 0 || escolhaIndex >= agendamentosDisponiveis.length) {
            await responder('❌ Opção inválida. Digite o número correspondente ao agendamento ou *0* para voltar.');
            return;
        }

        const agendamentoParaDeletar = agendamentosDisponiveis[escolhaIndex];

        try {
            await db.collection('agendamentos').doc(agendamentoParaDeletar.id).delete();
            await responder(`✅ *Agendamento cancelado com sucesso!*\n\nO horário de *${agendamentoParaDeletar.data}* às *${agendamentoParaDeletar.horario || agendamentoParaDeletar.hora}* foi liberado no sistema.`);

            estadoAtual.etapa = 'menu';
            estadoAtual.dadosTemporarios = null;
        } catch (error) {
            console.error('Erro ao deletar agendamento:', error);
            await responder('❌ Houve um erro interno ao tentar processar o cancelamento. Tente novamente mais tarde.');
        }
    }
}

iniciarSock().catch(erro => console.error('❌ Erro ao iniciar conexão com o WhatsApp:', erro));

app.get('/api/bot/status', (req, res) => {
    res.json({
        status: botStatus,
        qrCodeUrl: currentQrUrl
    });
});

// =====================================================================
// 🔔 ROTA HTTP GENÉRICA DE NOTIFICAÇÃO PUSH — chamada pelo frontend (Cliente.jsx,
// AdminPlanos.jsx) depois de uma ação já ter sido salva no Firestore. Nunca é o que decide
// se a ação deu certo — é só o "avisa aí" depois do fato.
// =====================================================================
app.post('/api/notificacoes/enviar', async (req, res) => {
    const { destino, identificador, titulo, corpo } = req.body;
    const resultado = await enviarPush({ destino, identificador, titulo, corpo });
    if (resultado.erro) return res.status(400).json({ error: resultado.erro });
    res.json({ success: true, enviados: resultado.enviados, aviso: resultado.aviso });
});

// =====================================================================
// 🔄 REINICIAR BOT (botão "Reiniciar" no painel admin)
// Encerra a conexão atual do Baileys e reconecta do zero — útil quando o bot fica
// "travado" (ex: WhatsApp Web desconectou sozinho e não se recuperou). Não depende de
// Docker/Portainer: reinicia a conexão em memória, não o processo Node inteiro.
// =====================================================================
app.post('/api/bot/reiniciar', async (req, res) => {
    if (reiniciandoBot) {
        return res.status(409).json({ ok: false, erro: 'Já existe um reinício em andamento. Aguarde.' });
    }

    reiniciandoBot = true;
    botStatus = 'reiniciando';
    currentQrUrl = null;
    console.log('🔄 Reinício do bot solicitado via painel admin...');

    // Responde já pro painel não ficar esperando a reconexão terminar.
    res.json({ ok: true, mensagem: 'Reinício iniciado. Acompanhe o status no painel.' });

    try {
        sock?.end(new Error('Reinício manual solicitado pelo painel admin'));
    } catch (erroEnd) {
        console.error('Aviso: erro ao encerrar conexão atual (seguindo para reconectar mesmo assim):', erroEnd);
    }

    botStatus = 'desconectado';

    try {
        await iniciarSock();
    } catch (erroInit) {
        console.error('❌ Erro ao reiniciar a conexão do WhatsApp:', erroInit);
        botStatus = 'desconectado';
    } finally {
        reiniciandoBot = false;
    }
});

// =====================================================================
// 🟢 ENVIO DE CONFIRMAÇÃO COM TEXTO DO PAINEL
// =====================================================================
app.post('/api/bot/enviar-confirmacao', async (req, res) => {
    const { telefone, nomeCliente, servico, data, horario, barbeiro, origemListaEspera } = req.body;

    if (!telefone) {
        return res.status(400).json({ error: 'Telefone é obrigatório' });
    }

    try {
        let numeroPuro = telefone.replace(/\D/g, '');
        if (!numeroPuro.startsWith('55')) {
            numeroPuro = '55' + numeroPuro;
        }

        const jidValido = await obterJidValido(numeroPuro);

        if (!jidValido) {
            console.log(`❌ WhatsApp não reconheceu o número: ${numeroPuro}`);
            return res.status(404).json({ error: 'Número não registrado no WhatsApp' });
        }

        const primeiroNome = nomeCliente ? nomeCliente.split(' ')[0] : 'Cliente';

        let mensagem = botConfig.msgConfirmacao
            .replace(/{nome}/g, primeiroNome)
            .replace(/{servico}/g, servico)
            .replace(/{data}/g, data)
            .replace(/{hora}/g, horario)
            .replace(/{barbeiro}/g, barbeiro);

        await enviarMensagem(jidValido, mensagem);

        if (origemListaEspera) {
            enviarPush({
                destino: 'cliente',
                identificador: telefone,
                titulo: 'Você foi chamado da lista de espera! 🎉',
                corpo: `Um horário vagou pra ${servico} dia ${data} às ${horario}, com ${barbeiro}.`
            }).catch(erro => console.error('Erro ao notificar cliente (lista de espera):', erro));
        }

        console.log(`✅ Confirmação enviada proativamente para ${primeiroNome}`);
        res.json({ success: true, message: 'Mensagem de confirmação enviada com sucesso!' });

    } catch (error) {
        console.error('❌ Erro ao disparar mensagem proativa:', error);
        res.status(500).json({ error: 'Erro ao enviar mensagem via WhatsApp' });
    }
});

// =====================================================================
// 🕐 LISTA DE ESPERA (MODO "BOT") — chamado pelo bloqueioUtils.js do frontend quando um
// horário vaga e o primeiro da fila precisa ser avisado e perguntado se ainda quer a vaga.
// A trava já foi transferida pro agendamento provisório (status "Aguardando Confirmação")
// pelo frontend antes desta chamada — aqui só falta perguntar pro cliente pelo WhatsApp e
// deixar o estado pronto pra reconhecer a resposta dele (ver processarMensagem acima).
// =====================================================================
app.post('/api/bot/lista-espera', async (req, res) => {
    const { telefone, nomeCliente, servico, data, horario, barbeiro, listaEsperaId, agendamentoId } = req.body;

    if (!telefone) {
        return res.status(400).json({ error: 'Telefone é obrigatório' });
    }

    try {
        let numeroPuro = telefone.replace(/\D/g, '');
        if (!numeroPuro.startsWith('55')) numeroPuro = '55' + numeroPuro;

        const jidValido = await obterJidValido(numeroPuro);

        if (!jidValido) {
            console.log(`❌ WhatsApp não reconheceu o número da lista de espera: ${numeroPuro}`);
            // Ninguém pra perguntar: passa a vaga direto pro próximo da fila, se houver.
            if (barbeiro && data && horario) await tentarProximoDaFila(barbeiro, data, horario);
            return res.status(404).json({ error: 'Número não registrado no WhatsApp' });
        }

        const primeiroNome = nomeCliente ? nomeCliente.split(' ')[0] : 'Cliente';

        // "data" chega em ISO (AAAA-MM-DD), igual bloqueioUtils.js usa pra achar o próximo da
        // fila — formata aqui só pro texto amigável, mesmo padrão de /api/bot/enviar-confirmacao.
        const [ano, mes, dia] = String(data || '').split('-');
        const dataFormatada = (ano && mes && dia) ? `${dia}/${mes}/${ano}` : data;

        let mensagem = botConfig.msgListaEspera
            .replace(/{nome}/g, primeiroNome)
            .replace(/{servico}/g, servico || 'seu serviço')
            .replace(/{data}/g, dataFormatada)
            .replace(/{hora}/g, horario)
            .replace(/{barbeiro}/g, barbeiro);

        await enviarMensagem(jidValido, mensagem);

        enviarPush({
            destino: 'cliente',
            identificador: telefone,
            titulo: 'Você foi chamado da lista de espera! 🎉',
            corpo: `Um horário vagou pra ${servico || 'seu serviço'} dia ${dataFormatada} às ${horario}. Responda no WhatsApp pra confirmar!`
        }).catch(erro => console.error('Erro ao notificar cliente (lista de espera):', erro));

        estadosUsuarios[numeroPuro] = {
            etapa: 'aguardando_confirmacao_espera',
            clienteData: estadosUsuarios[numeroPuro]?.clienteData || null,
            dadosTemporarios: { telefone, nomeCliente, servico, data, horario, barbeiro, listaEsperaId, agendamentoId }
        };

        console.log(`✅ Pergunta da lista de espera enviada para ${primeiroNome}`);
        res.json({ success: true, message: 'Pergunta da lista de espera enviada com sucesso!' });

    } catch (error) {
        console.error('❌ Erro ao avisar candidato da lista de espera:', error);
        res.status(500).json({ error: 'Erro ao enviar mensagem via WhatsApp' });
    }
});

// =====================================================================
// 📣 DISPARO EM MASSA (MARKETING E CAMPANHAS)
// =====================================================================
app.post('/api/bot/campanha', async (req, res) => {
    const { mensagem } = req.body;

    if (!mensagem) {
        return res.status(400).json({ error: 'A mensagem não pode estar vazia.' });
    }
    if (botStatus !== 'conectado') {
        return res.status(400).json({ error: 'O Bot precisa estar conectado ao WhatsApp.' });
    }

    res.json({ success: true, message: 'Disparo iniciado em background.' });

    try {
        console.log('📣 Buscando clientes para o disparo em massa...');
        const clientesSnap = await db.collection('clientes').get();
        const clientes = [];
        clientesSnap.forEach(doc => clientes.push(doc.data()));

        console.log(`📣 Iniciando disparo em massa para ${clientes.length} clientes cadastrados.`);

        for (const cliente of clientes) {
            const primeiroNome = cliente.nome ? cliente.nome.split(' ')[0] : 'Cliente';

            let jidValido = null;
            let numeroUsado = '';

            if (cliente.whatsappId) {
                let numWpp = cliente.whatsappId.replace(/\D/g, '');
                if (!numWpp.startsWith('55') && numWpp.length >= 10) numWpp = '55' + numWpp;
                try {
                    jidValido = await obterJidValido(numWpp);
                    if (jidValido) numeroUsado = numWpp;
                } catch (e) {}
            }

            if (!jidValido && cliente.telefone) {
                let numTel = cliente.telefone.toString().replace(/\D/g, '');
                if (!numTel.startsWith('55') && numTel.length >= 10) numTel = '55' + numTel;
                try {
                    jidValido = await obterJidValido(numTel);
                    if (jidValido) numeroUsado = numTel;
                } catch (e) {}
            }

            if (jidValido) {
                try {
                    const msgFormatada = mensagem.replace(/{nome}/g, primeiroNome);
                    await enviarMensagem(jidValido, msgFormatada);
                    console.log(`✅ [Campanha] Mensagem enviada para ${primeiroNome} (${numeroUsado})`);

                    const tempoEspera = Math.floor(Math.random() * (10000 - 5000 + 1)) + 5000;
                    await delay(tempoEspera);
                } catch (err) {
                    console.error(`❌ Erro ao enviar campanha para ${primeiroNome}:`, err.message);
                }
            } else {
                console.log(`⚠️ [Ignorado] Não foi possível encontrar um WhatsApp válido para ${primeiroNome}.`);
            }
        }
        console.log('🏁 Disparo de Campanha finalizado com sucesso!');
    } catch (error) {
        console.error('❌ Erro na rotina de campanha:', error);
    }
});

// =====================================================================
// ⏰ CRON JOB 1: LEMBRETES DIÁRIOS DOS AGENDAMENTOS DO DIA
// =====================================================================
cron.schedule('* * * * *', async () => {
    if (!botConfig.lembretesAtivos || botStatus !== 'conectado') return;

    const agora = new Date();
    const options = { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false };
    const horaAtual = agora.toLocaleTimeString('pt-BR', options);

    if (botConfig.horarios.includes(horaAtual)) {
        console.log(`⏳ Iniciando rotina de lembretes para as ${horaAtual}...`);

        try {
            const dataHoje = agora.toISOString().split('T')[0];

            const snap = await db.collection('agendamentos')
                .where('data', '==', dataHoje)
                .where('status', '==', 'Pendente')
                .get();

            snap.forEach(async (doc) => {
                const agenda = doc.data();
                const tel = agenda.clienteTelefone;

                try {
                    let numeroPuro = tel.replace(/\D/g, '');
                    if (!numeroPuro.startsWith('55')) numeroPuro = '55' + numeroPuro;

                    const jidValido = await obterJidValido(numeroPuro);
                    if (jidValido) {
                        const primeiroNome = agenda.clienteNome ? agenda.clienteNome.split(' ')[0] : 'Cliente';
                        const horarioCorte = agenda.hora || agenda.horario;

                        let msgLembrete = botConfig.msgLembrete
                            .replace(/{nome}/g, primeiroNome)
                            .replace(/{hora}/g, horarioCorte);

                        await enviarMensagem(jidValido, msgLembrete);
                        console.log(`✅ Lembrete enviado para ${primeiroNome}`);
                    }

                    // Também manda o lembrete como notificação push, pra quem tiver o app
                    // instalado com notificações ativadas — independe do WhatsApp ter
                    // reconhecido o número ou não.
                    enviarPush({
                        destino: 'cliente',
                        identificador: tel,
                        titulo: 'Lembrete de horário ⏰',
                        corpo: `Seu corte hoje é às ${agenda.hora || agenda.horario} na Barbearia Antunes.`
                    }).catch(e => console.error('Erro ao notificar cliente (lembrete):', e));
                } catch (e) {
                    console.error(`❌ Erro ao enviar lembrete para ${agenda.clienteTelefone}:`, e);
                }
            });
        } catch (error) {
            console.error('❌ Erro na rotina de lembretes:', error);
        }
    }
});

// =====================================================================
// 🎯 CRON JOB 2: RADAR DE CLIENTES SUMIDOS (Roda todo dia às 10:00 da manhã)
// =====================================================================
cron.schedule('0 10 * * *', async () => {
    if (!botConfig.radarAtivo || botStatus !== 'conectado') return;

    console.log(`🎯 Iniciando Radar de Clientes Sumidos (Inativos há ${botConfig.radarDias} dias)...`);

    try {
        // Calcula a data exata de X dias atrás
        const dataAlvo = new Date();
        dataAlvo.setDate(dataAlvo.getDate() - botConfig.radarDias);
        const dataAlvoStr = dataAlvo.toISOString().split('T')[0];

        // Busca os agendamentos que aconteceram EXATAMENTE naquela data do passado
        const snapAgendamentos = await db.collection('agendamentos').where('data', '==', dataAlvoStr).get();

        const clientesParaVerificar = new Set();
        const detalhesClientes = {};

        snapAgendamentos.forEach(doc => {
            const agenda = doc.data();
            if (agenda.clienteTelefone) {
                clientesParaVerificar.add(agenda.clienteTelefone);
                detalhesClientes[agenda.clienteTelefone] = agenda;
            }
        });

        console.log(`🎯 Foram encontrados ${clientesParaVerificar.size} clientes que cortaram no dia ${dataAlvoStr}. Verificando se retornaram...`);

        for (const tel of clientesParaVerificar) {
            // Verifica se o cliente marcou algum corte DEPOIS daquela data antiga
            const snapFuturo = await db.collection('agendamentos')
                .where('clienteTelefone', '==', tel)
                .where('data', '>', dataAlvoStr)
                .get();

            // Se o snapFuturo for VAZIO, significa que ele realmente nunca mais voltou!
            if (snapFuturo.empty) {
                const agendaAntiga = detalhesClientes[tel];
                const primeiroNome = agendaAntiga.clienteNome ? agendaAntiga.clienteNome.split(' ')[0] : 'Cliente';

                try {
                    let numeroPuro = tel.replace(/\D/g, '');
                    if (!numeroPuro.startsWith('55')) numeroPuro = '55' + numeroPuro;

                    const jidValido = await obterJidValido(numeroPuro);

                    if (jidValido) {
                        let msgRadar = botConfig.msgRadar.replace(/{nome}/g, primeiroNome);
                        await enviarMensagem(jidValido, msgRadar);
                        console.log(`✅ [Radar] Mensagem de resgate enviada para ${primeiroNome} (${numeroPuro})`);

                        // Anti-Ban
                        const tempoEspera = Math.floor(Math.random() * (10000 - 5000 + 1)) + 5000;
                        await delay(tempoEspera);
                    }
                } catch (e) {
                    console.error(`❌ Erro ao enviar radar para ${primeiroNome}:`, e.message);
                }
            } else {
                console.log(`⏭️ [Radar] Cliente ${detalhesClientes[tel].clienteNome} ignorado (já retornou à barbearia depois dessa data).`);
            }
        }
        console.log('🏁 Radar de Sumidos finalizado!');
    } catch (error) {
        console.error('❌ Erro na rotina do Radar:', error);
    }
});

// =====================================================================
// ⭐ ROTA DE NPS (AVALIAÇÃO PÓS-CORTE DINÂMICA)
// =====================================================================
app.post('/api/bot/nps', async (req, res) => {
    const { telefone, nomeCliente, barbeiro } = req.body;

    if (!telefone) return res.status(400).json({ error: 'Telefone é obrigatório' });
    if (!botConfig.npsAtivo) return res.json({ success: false, message: 'NPS desativado.' });

    res.json({ success: true, message: 'Pesquisa NPS agendada.' });

    const tempoDeEspera = botConfig.npsTempoMinutos * 60 * 1000;

    setTimeout(async () => {
        try {
            let numeroPuro = telefone.replace(/\D/g, '');
            if (!numeroPuro.startsWith('55')) numeroPuro = '55' + numeroPuro;

            const jidValido = await obterJidValido(numeroPuro);

            if (jidValido) {
                const primeiroNome = nomeCliente ? nomeCliente.split(' ')[0] : 'Cliente';

                let mensagemNPS = botConfig.msgNPS
                    .replace(/{nome}/g, primeiroNome)
                    .replace(/{barbeiro}/g, barbeiro);

                await enviarMensagem(jidValido, mensagemNPS);
                console.log(`✅ Pesquisa de NPS enviada com sucesso para ${primeiroNome}`);

                // 👇 A MÁGICA AQUI: Coloca o cliente no estado de avaliação
                if (!estadosUsuarios[numeroPuro]) {
                    estadosUsuarios[numeroPuro] = { etapa: 'aguardando_nps', dadosTemporarios: null };
                }
                estadosUsuarios[numeroPuro].etapa = 'aguardando_nps';
                // Salvamos o nome do barbeiro para saber quem ele está avaliando
                estadosUsuarios[numeroPuro].dadosTemporarios = { barbeiro: barbeiro, nomeCliente: nomeCliente };
            }
        } catch (error) {
            console.error('❌ Erro ao enviar NPS:', error);
        }
    }, tempoDeEspera);
});

// Lê a porta da variável de ambiente PORT (é isso que o docker-compose.yml já tenta passar),
// com 3001 como padrão pra continuar funcionando igual antes se você rodar "node index.js" direto.
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`API do Bot rodando na porta ${PORT}`);
});
