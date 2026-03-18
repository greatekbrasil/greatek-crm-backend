const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors()); // Permite que o Front-end conecte sem bloqueios
app.use(express.json());

// Pega a URL do banco que o Railway fornece automaticamente
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Rota principal: Lendo os Leads!
// Quando o Dashboard chamar /leads?vendedor=carlos_silva, nós buscamos no Postgres
app.get('/leads', async (req, res) => {
    try {
        const { vendedor } = req.query;
        let query = 'SELECT * FROM leads';
        let values = [];

        // Filtra por vendedor se a tela não for a da Diretoria
        if (vendedor && vendedor !== 'diretor') {
            query += ' WHERE vendedor_responsavel = $1';
            values.push(vendedor);
        }

        query += ' ORDER BY id DESC LIMIT 50';

        const result = await pool.query(query, values);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar no banco de dados' });
    }
});

// Iniciando o Servidor na porta do Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor Greatek rodando e conectado ao banco na porta ${PORT}`);
});
