const admin = require('firebase-admin');

let serviceAccount;

// Verifica se está no servidor (Portainer) ou no seu computador local
if (process.env.FIREBASE_JSON) {
  serviceAccount = JSON.parse(process.env.FIREBASE_JSON);
} else {
  serviceAccount = require('./firebase-key.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// ... resto do seu código (exportar db, etc)
const serviceAccount = require('./firebase-key.json');

// Inicializa a conexão com o banco usando a sua chave secreta
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

module.exports = { db };