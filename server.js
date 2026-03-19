const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Rota principal: lê os leads analisados pelo SalesBud
app.get('/leads', async (req, res) => {
    try {
        const { vendedor } = req.query;

        let query = 'SELECT * FROM leads_analisados';
        let values = [];

        if (vendedor && vendedor !== 'diretor') {
            query += ' WHERE instancia_vendedor = $1';
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor Greatek rodando na porta ${PORT}`);
});
