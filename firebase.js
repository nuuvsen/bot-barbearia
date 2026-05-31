const admin = require('firebase-admin');
const serviceAccount = require('./firebase-key.json');

// Inicializa a conexão com o banco usando a sua chave secreta
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

module.exports = { db };