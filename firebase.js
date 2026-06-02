const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

let serviceAccount;

if (process.env.FIREBASE_JSON) {
  try {
    let jsonString = process.env.FIREBASE_JSON;
    
    // Se o texto for Base64 (não começa com '{'), nós convertemos de volta
    if (!jsonString.trim().startsWith('{')) {
      jsonString = Buffer.from(jsonString, 'base64').toString('utf8');
    }

    serviceAccount = JSON.parse(jsonString);
  } catch (error) {
    console.error("❌ O formato da chave FIREBASE_JSON que chegou no container está quebrado.");
    console.error("Erro interno:", error.message);
    process.exit(1); 
  }
} 
else {
  const caminhoChave = path.join(__dirname, 'firebase-key.json');
  
  if (fs.existsSync(caminhoChave)) {
    serviceAccount = require(caminhoChave);
  } else {
    console.error("❌ CREDENCIAIS DO FIREBASE NÃO ENCONTRADAS!");
    process.exit(1);
  }
}

// Inicializa o Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Exporta o banco de dados
const db = admin.firestore();
module.exports = db;