const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { db } = require('./firebase');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json()); 

let currentQrUrl = null;
let botStatus = 'desconectado';
const estadosUsuarios = {};

// Função de pausa (delay) global para Anti-Ban
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    msgNPS: 'Olá, {nome}! Esperamos que tenha curtido o seu visual hoje na Barbearia Antunes. ✂️\n\nComo foi o seu atendimento com o profissional *{barbeiro}*?\n\nResponda a esta mensagem com uma nota de *1 a 5* ⭐ para nos ajudar a manter a qualidade lá em cima!'
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

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', async (qr) => {
    console.log('QR Code recebido. Aguardando leitura...');
    botStatus = 'aguardando_qr';
    currentQrUrl = await qrcode.toDataURL(qr); 
});

client.on('ready', () => {
    console.log('Bot conectado ao WhatsApp e pronto!');
    botStatus = 'conectado';
    currentQrUrl = null;
});

client.on('disconnected', (reason) => {
    console.log('Bot desconectado:', reason);
    botStatus = 'desconectado';
});

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

client.on('message', async msg => {
    if (msg.fromMe || !msg.body || msg.type === 'e2e_notification' || msg.type === 'notification_template') {
        return; 
    }

    const chat = await msg.getChat();
    if (chat.isGroup) return;

    const texto = msg.body.toLowerCase().trim();
    const contato = await msg.getContact();
    const numeroClienteWpp = contato.number || msg.from.replace('@c.us', '').replace('@lid', ''); 

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
                await msg.reply(`*Olá! Bem-vindo à Barbearia Antunes!* 💈\n\nIdentificamos que este é o seu primeiro contato por este canal.\n\n*Você já possui cadastro no nosso site de agendamentos?*\n\nDigite o número da opção:\n*1️⃣* - Sim, já sou cliente\n*2️⃣* - Não, quero conhecer/agendar`);
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
                // Salva no Firebase na nova coleção "avaliacoes"
                await db.collection('avaliacoes').add({
                    nota: nota,
                    barbeiro: estadoAtual.dadosTemporarios.barbeiro,
                    clienteNome: estadoAtual.dadosTemporarios.nomeCliente,
                    telefone: numeroClienteWpp,
                    data: new Date().toISOString()
                });

                await msg.reply('Obrigado pela sua avaliação! 🙏 Isso nos ajuda a manter o padrão Antunes de qualidade. Volte sempre!');
                
                // Libera o cliente de volta pro menu normal
                estadoAtual.etapa = 'menu';
                estadoAtual.dadosTemporarios = null;
            } catch (error) {
                console.error('Erro ao salvar avaliação:', error);
            }
        } else {
            await msg.reply('⚠️ Por favor, digite apenas um número de *1 a 5* para avaliar o seu atendimento:');
        }
        return; // Para a execução aqui
    }

    if (estadoAtual.etapa === 'perguntando_se_cliente') {
        if (texto === '1' || texto === 'sim') {
            estadoAtual.etapa = 'aguardando_numero_registro';
            await msg.reply('Perfeito! Para que eu possa localizar o seu perfil, por favor *digite o seu número de telefone com DDD* (ex: 53999999999), apenas os números:');
            return;
        } else if (texto === '2' || texto === 'não' || texto === 'nao') {
            estadoAtual.etapa = 'onboarding_finalizado_visitante';
            await msg.reply('Seja muito bem-vindo! Você pode realizar o seu agendamento escolhendo os melhores profissionais e horários diretamente no nosso site: http://localhost:3000 \n\nCaso precise de suporte humano, digite *3* para falar com o barbeiro.');
            return;
        } else {
            await msg.reply('Por favor, responda apenas:\n*1* - Se você já possui cadastro\n*2* - Se você ainda não possui cadastro');
            return;
        }
    }

    if (estadoAtual.etapa === 'aguardando_numero_registro') {
        const numeroLimpo = limparNumeroDigitado(texto);
        
        if (numeroLimpo.length < 10 || numeroLimpo.length > 11) {
            await msg.reply('⚠️ O número digitado parece inválido. Certifique-se de incluir o DDD e o número completo (ex: 53997102442). Digite novamente:');
            return;
        }

        try {
            const variacoesBusca = obterVariacoesTelefone(numeroLimpo);
            const clienteSnapshot = await db.collection('clientes').where('telefone', 'in', variacoesBusca).get();

            if (clienteSnapshot.empty) {
                await msg.reply('❌ Não encontramos nenhum cadastro com esse número no nosso sistema.\n\nPor favor, confira o número e digite novamente ou digite *Menu* para reiniciar.');
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
            
            msg.body = 'menu'; 
        } catch (error) {
            console.error('Erro ao vincular ID do cliente:', error);
            await msg.reply('Ocorreu um erro interno ao salvar seus dados. Digite o número novamente para tentar o vínculo:');
            return;
        }
    }

    if (estadoAtual.etapa === 'onboarding_finalizado_visitante') {
        if (texto === '3') {
            await msg.reply('Um momento, por favor. O barbeiro foi notificado e irá responder assim que possível. ⏳');
        } else {
            estadoAtual.etapa = 'verificando_identidade';
            msg.body = 'menu';
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

            await msg.reply(`*Olá, ${primeiroNome}!* Bem-vindo de volta à Barbearia Antunes! 💈${resumoAgendamento}\n\nComo posso ajudar hoje? Digite o número da opção:\n\n*1️⃣* - Detalhar meus agendamentos\n*2️⃣* - Cancelar um agendamento\n*3️⃣* - Falar com o barbeiro`);
            
        } catch (error) {
            console.error('Erro no menu principal:', error);
            await msg.reply('❌ Erro ao carregar os dados da agenda. Digite "Menu" para tentar novamente.');
        }
        return;
    }

    if (estadoAtual.etapa === 'menu') {
        if (texto === '1') {
            await msg.reply('⏳ Buscando detalhes dos seus horários...');
            try {
                const snapshot = await db.collection('agendamentos').where('clienteTelefone', 'in', telefonesBuscaAgendamento).get();

                if (snapshot.empty) {
                    await msg.reply('Você não possui nenhum agendamento registrado.');
                    return;
                }

                let msgAgendamentos = '*Seus Agendamentos Cadastrados:* 📅\n\n';
                snapshot.forEach(doc => {
                    const agenda = doc.data();
                    msgAgendamentos += `✂️ *Serviço:* ${agenda.servico.nome || agenda.servico}\n`;
                    msgAgendamentos += `🕒 *Data/Hora:* ${agenda.data} às ${agenda.horario || agenda.hora}\n`;
                    msgAgendamentos += `💈 *Barbeiro:* ${agenda.barbeiro.nome || agenda.barbeiro}\n\n`;
                });

                await msg.reply(msgAgendamentos);
            } catch (error) {
                console.error('Erro ao detalhar horários:', error);
                await msg.reply('Erro ao buscar os agendamentos.');
            }
            return;
        }

        if (texto === '2') {
            try {
                const snapshot = await db.collection('agendamentos').where('clienteTelefone', 'in', telefonesBuscaAgendamento).get();

                if (snapshot.empty) {
                    await msg.reply('Você não possui agendamentos ativos para cancelar.');
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

                await msg.reply(listaCancelamento);
            } catch (error) {
                console.error('Erro ao listar para cancelamento:', error);
                await msg.reply('Erro ao carregar lista de cancelamento.');
            }
            return;
        }

        if (texto === '3') {
            await msg.reply('Um momento, por favor. O barbeiro foi notificado e irá responder assim que possível. ⏳');
            return;
        }
    }

    if (estadoAtual.etapa === 'aguardando_selecao_cancelamento') {
        if (texto === '0') {
            estadoAtual.etapa = 'menu';
            estadoAtual.dadosTemporarios = null;
            await msg.reply('Operação cancelada. Digite "Menu" para retornar.');
            return;
        }

        const escolhaIndex = parseInt(texto) - 1;
        const agendamentosDisponiveis = estadoAtual.dadosTemporarios;

        if (isNaN(escolhaIndex) || escolhaIndex < 0 || escolhaIndex >= agendamentosDisponiveis.length) {
            await msg.reply('❌ Opção inválida. Digite o número correspondente ao agendamento ou *0* para voltar.');
            return;
        }

        const agendamentoParaDeletar = agendamentosDisponiveis[escolhaIndex];

        try {
            await db.collection('agendamentos').doc(agendamentoParaDeletar.id).delete();
            await msg.reply(`✅ *Agendamento cancelado com sucesso!*\n\nO horário de *${agendamentoParaDeletar.data}* às *${agendamentoParaDeletar.horario || agendamentoParaDeletar.hora}* foi liberado no sistema.`);
            
            estadoAtual.etapa = 'menu';
            estadoAtual.dadosTemporarios = null;
        } catch (error) {
            console.error('Erro ao deletar agendamento:', error);
            await msg.reply('❌ Houve um erro interno ao tentar processar o cancelamento. Tente novamente mais tarde.');
        }
    }
});

client.initialize();

app.get('/api/bot/status', (req, res) => {
    res.json({
        status: botStatus,
        qrCodeUrl: currentQrUrl
    });
});

// =====================================================================
// 🟢 ENVIO DE CONFIRMAÇÃO COM TEXTO DO PAINEL
// =====================================================================
app.post('/api/bot/enviar-confirmacao', async (req, res) => {
    const { telefone, nomeCliente, servico, data, horario, barbeiro } = req.body;

    if (!telefone) {
        return res.status(400).json({ error: 'Telefone é obrigatório' });
    }

    try {
        let numeroPuro = telefone.replace(/\D/g, ''); 
        if (!numeroPuro.startsWith('55')) {
            numeroPuro = '55' + numeroPuro;
        }

        const contatoValido = await client.getNumberId(numeroPuro);

        if (!contatoValido) {
            console.log(`❌ WhatsApp não reconheceu o número: ${numeroPuro}`);
            return res.status(404).json({ error: 'Número não registrado no WhatsApp' });
        }

        const chatId = contatoValido._serialized;
        const primeiroNome = nomeCliente ? nomeCliente.split(' ')[0] : 'Cliente';

        let mensagem = botConfig.msgConfirmacao
            .replace(/{nome}/g, primeiroNome)
            .replace(/{servico}/g, servico)
            .replace(/{data}/g, data)
            .replace(/{hora}/g, horario)
            .replace(/{barbeiro}/g, barbeiro);

        await client.sendMessage(chatId, mensagem);
        
        console.log(`✅ Confirmação enviada proativamente para ${primeiroNome}`);
        res.json({ success: true, message: 'Mensagem de confirmação enviada com sucesso!' });
        
    } catch (error) {
        console.error('❌ Erro ao disparar mensagem proativa:', error);
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

            let contatoValido = null;
            let numeroUsado = '';

            if (cliente.whatsappId) {
                let numWpp = cliente.whatsappId.replace(/\D/g, '');
                if (!numWpp.startsWith('55') && numWpp.length >= 10) numWpp = '55' + numWpp;
                try { 
                    contatoValido = await client.getNumberId(numWpp); 
                    if (contatoValido) numeroUsado = numWpp;
                } catch (e) {}
            }

            if (!contatoValido && cliente.telefone) {
                let numTel = cliente.telefone.toString().replace(/\D/g, '');
                if (!numTel.startsWith('55') && numTel.length >= 10) numTel = '55' + numTel;
                try { 
                    contatoValido = await client.getNumberId(numTel); 
                    if (contatoValido) numeroUsado = numTel;
                } catch (e) {}
            }

            if (contatoValido) {
                try {
                    const msgFormatada = mensagem.replace(/{nome}/g, primeiroNome);
                    await client.sendMessage(contatoValido._serialized, msgFormatada);
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
                    
                    const contatoValido = await client.getNumberId(numeroPuro);
                    if (contatoValido) {
                        const primeiroNome = agenda.clienteNome ? agenda.clienteNome.split(' ')[0] : 'Cliente';
                        const horarioCorte = agenda.hora || agenda.horario;

                        let msgLembrete = botConfig.msgLembrete
                            .replace(/{nome}/g, primeiroNome)
                            .replace(/{hora}/g, horarioCorte);

                        await client.sendMessage(contatoValido._serialized, msgLembrete);
                        console.log(`✅ Lembrete enviado para ${primeiroNome}`);
                    }
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
                    
                    const contatoValido = await client.getNumberId(numeroPuro);
                    
                    if (contatoValido) {
                        let msgRadar = botConfig.msgRadar.replace(/{nome}/g, primeiroNome);
                        await client.sendMessage(contatoValido._serialized, msgRadar);
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

            const contatoValido = await client.getNumberId(numeroPuro);

            if (contatoValido) {
                const chatId = contatoValido._serialized;
                const primeiroNome = nomeCliente ? nomeCliente.split(' ')[0] : 'Cliente';

                let mensagemNPS = botConfig.msgNPS
                    .replace(/{nome}/g, primeiroNome)
                    .replace(/{barbeiro}/g, barbeiro);

                await client.sendMessage(chatId, mensagemNPS);
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

const PORT = 3001;
app.listen(PORT, () => {
    console.log(`API do Bot rodando na porta ${PORT}`);
});