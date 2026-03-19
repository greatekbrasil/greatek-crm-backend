const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- Rota de Leads (Listagem) ---
app.get('/leads', async (req, res) => {
    try {
        const { vendedor } = req.query;
        let query = 'SELECT * FROM leads_analisados';
        let values = [];

        if (vendedor && vendedor !== 'diretor') {
            query += ' WHERE instancia_vendedor = $1';
            values.push(vendedor);
        }

        query += ' ORDER BY id DESC LIMIT 200';
        const result = await pool.query(query, values);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar no banco de dados' });
    }
});

// --- Rota da Diretiva Executiva IA ---
app.get('/diretiva/:vendedor', async (req, res) => {
    try {
        const { vendedor } = req.params;
        const result = await pool.query(
            'SELECT * FROM leads_analisados WHERE instancia_vendedor = $1 ORDER BY id DESC LIMIT 20',
            [vendedor]
        );
        const leads = result.rows;

        if (leads.length === 0) {
            return res.json({ diretiva: 'Nenhum lead registrado para este vendedor ainda.' });
        }

        const leadsTexto = leads.map((l, i) => `
Lead ${i + 1}:
- Nome: ${l.nome_lead || 'Não identificado'}
- Empresa: ${l.nome_empresa || 'Não informado'}
- Interesse: ${l.interesse_lead || 'Não informado'}
- Urgência: ${l.urgencia || 'Não informado'}
- Temperatura: ${l.temperatura_lead || 'Não informado'}
- Probabilidade de fechamento: ${l.probabilidade || 0}%
- Objeções: ${l.objecoes || 'Nenhuma'}
- Resumo: ${l.resumo_ia || 'Sem resumo'}
- Próximo passo: ${l.proximo_passo || 'Não definido'}
`).join('\n');

        const prompt = `Você é um diretor comercial sênior. Analise o vendedor ${vendedor} com base nos seguintes leads do CRM:\n${leadsTexto}\n
        Gere uma Diretiva Executiva com: PONTOS FORTES, GAPS CRÍTICOS, PRODUTOS SUGERIDOS, PLANO DE AÇÃO e POTENCIAL DE RECEITA. Seja direto e executivo.`;

        const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
                })
            }
        );

        const geminiData = await geminiRes.json();
        const diretiva = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
        res.json({ diretiva: diretiva || 'Erro ao gerar diretiva via IA.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao gerar diretiva executiva.' });
    }
});

// --- WEBHOOK: Recebe mensagens da EvolutionAPI e processa com IA ---
app.post('/webhook', async (req, res) => {
    try {
        const event = req.body;
        
        if (event.event !== 'messages.upsert' || event.data?.key?.fromMe) {
            return res.status(200).send('Event ignored');
        }

        const instance = event.instance;
        const pushName = event.data?.pushName || 'Lead Desconhecido';
        const phone = event.data?.key?.remoteJid?.split('@')[0] || '';
        const messageText = event.data?.message?.conversation || 
                            event.data?.message?.extendedTextMessage?.text || 
                            'Mensagem de mídia';

        console.log(`[Webhook] Recebido de ${phone} para instância ${instance}`);

        const promptAnalysis = `Analise este lead e retorne APENAS um JSON (sem markdown).
        Campos: nome_empresa, urgencia, resumo, resumo_ia, interesse_lead, produto_ofertado, nome_lead, objecoes, gaps, probabilidade (número), temperatura_lead, proximo_passo.
        Mensagem: "${messageText}"`;

        const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: promptAnalysis }] }],
                    generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
                })
            }
        );

        const geminiData = await geminiRes.json();
        let rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        
        // Limpeza de Markdown se houver
        rawText = rawText.replace(/```json|```/g, '').trim();
        
        let aiResponse;
        try {
            aiResponse = JSON.parse(rawText);
        } catch (e) {
            console.error('[JSON Parse Error] Texto bruto da IA:', rawText);
            throw new Error('Falha ao processar resposta da IA');
        }

        const query = `
            INSERT INTO leads_analisados (
                nome_empresa, urgencia, instancia_vendedor, resumo, 
                objecoes, gaps, produto_ofertado, nome_lead, 
                telefone, resumo_ia, interesse_lead, probabilidade, 
                temperatura_lead, proximo_passo, resumo
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            RETURNING id;
        `;
        
        // CORREÇÃO: Notei que 'resumo' apareceu duplicado no SQL acima por erro de digitação.
        // Removendo a duplicidade e garantindo 14 valores.
        const cleanQuery = `
            INSERT INTO leads_analisados (
                nome_empresa, urgencia, instancia_vendedor, resumo, 
                objecoes, gaps, produto_ofertado, nome_lead, 
                telefone, resumo_ia, interesse_lead, probabilidade, 
                temperatura_lead, proximo_passo
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING id;
        `;

        const values = [
            aiResponse.nome_empresa || 'Não informado',
            aiResponse.urgencia || 'baixa',
            instance,
            aiResponse.resumo || messageText,
            aiResponse.objecoes || 'Nenhuma',
            aiResponse.gaps || 'Nenhum',
            aiResponse.produto_ofertado || 'A definir',
            aiResponse.nome_lead || pushName,
            phone,
            aiResponse.resumo_ia || 'Análise automática',
            aiResponse.interesse_lead || 'Interesse geral',
            parseInt(aiResponse.probabilidade) || 0,
            aiResponse.temperatura_lead || 'Frio',
            aiResponse.proximo_passo || 'Aguardar contato'
        ];

        const dbRes = await pool.query(cleanQuery, values);
        console.log(`[Webhook] Salvo ID: ${dbRes.rows[0].id}`);
        res.status(201).json({ success: true });

    } catch (err) {
        console.error('[Webhook Error]', err);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
