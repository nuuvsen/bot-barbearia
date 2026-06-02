const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

let serviceAccount;

// 1. Tenta pegar a chave do Portainer (Variável de Ambiente)
if (process.env.FIREBASE_JSON) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_JSON);
  } catch (error) {
    console.error("❌ Erro ao ler a variável FIREBASE_JSON. O JSON está mal formatado.");
    process.exit(1);
  }
} 
// 2. Se não tem variável, tenta pegar o arquivo físico (Seu PC)
else {
  const caminhoChave = path.join(__dirname, 'firebase-key.json');
  
  if (fs.existsSync(caminhoChave)) {
    serviceAccount = require(caminhoChave);
  } else {
    console.error("❌ CREDENCIAIS DO FIREBASE NÃO ENCONTRADAS!");
    console.error("Você precisa configurar a variável FIREBASE_JSON no Portainer.");
    process.exit(1); // Para o bot graciosamente sem dar aquele erro gigante
  }
}

// 3. Inicializa o Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// ... resto do seu código ...