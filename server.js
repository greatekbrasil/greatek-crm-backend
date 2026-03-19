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

        const promptAnalysis = `Você é um analista comercial sênior da Greatek. Analise a mensagem de um lead e retorne um JSON puro.
        CAMPOS REQUERIDOS:
        - nome_empresa: (se houver)
        - urgencia: (baixa, media, alta)
        - resumo: (resumo fático do que ele disse)
        - resumo_ia: (ANÁLISE ESTRATÉGICA curta sobre a dor e como o vendedor deve agir para fechar)
        - interesse_lead: (que produto/serviço ele busca)
        - produto_ofertado: (o que a Greatek deve oferecer)
        - nome_lead: (nome completo se tiver)
        - objecoes: (principais barreiras citadas)
        - gaps: (o que faltou para qualificar o lead)
        - probabilidade: (número 0-100)
        - temperatura_lead: (Frio, Morno, Quente)
        - proximo_passo: (recomendação de ação imediata)

        Mensagem: "${messageText}"
        Remetente: "${pushName}"`;

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
            throw new Error('Falha ao processar resposta da IA: ' + rawText.substring(0, 100));
        }

        const cleanQuery = `
            INSERT INTO leads_analisados (
                nome_empresa, urgencia, instancia_vendedor, resumo, 
                objecoes, gaps, produto_ofertado, nome_lead, 
                telefone, resumo_ia, interesse_lead, probabilidade, 
                temperatura_lead, proximo_passo
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT (telefone) DO UPDATE SET
                nome_empresa = EXCLUDED.nome_empresa,
                urgencia = EXCLUDED.urgencia,
                instancia_vendedor = EXCLUDED.instancia_vendedor,
                resumo = EXCLUDED.resumo,
                objecoes = EXCLUDED.objecoes,
                gaps = EXCLUDED.gaps,
                produto_ofertado = EXCLUDED.produto_ofertado,
                nome_lead = EXCLUDED.nome_lead,
                resumo_ia = EXCLUDED.resumo_ia,
                interesse_lead = EXCLUDED.interesse_lead,
                probabilidade = EXCLUDED.probabilidade,
                temperatura_lead = EXCLUDED.temperatura_lead,
                proximo_passo = EXCLUDED.proximo_passo
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
            aiResponse.resumo_ia || null, // Se falhar a IA, deixa o frontend mostrar o resumo bruto
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

// --- Rota para buscar um lead específico pelo ID ---
app.get('/leads/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM leads_analisados WHERE id = $1', [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Lead não encontrado' });
        }
        
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar detalhes do lead' });
    }
});

// --- Rota para deletar um lead ---
app.delete('/leads/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM leads_analisados WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao deletar lead' });
    }
});

// --- Rota para atualizar um lead ---
app.put('/leads/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nome_lead, nome_empresa, urgencia, temperatura_lead, situacao } = req.body;
        
        const query = `
            UPDATE leads_analisados 
            SET nome_lead = $1, nome_empresa = $2, urgencia = $3, temperatura_lead = $4 
            WHERE id = $5
        `;
        await pool.query(query, [nome_lead, nome_empresa, urgencia, temperatura_lead, id]);
        
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao atualizar lead' });
    }
});

// --- Rota para histórico de conversa (simplificado) ---
app.get('/leads/:id/historico', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT resumo, resumo_ia FROM leads_analisados WHERE id = $1', [id]);
        
        if (result.rows.length === 0) return res.json([]);
        
        // Retorna o resumo como se fosse a primeira entrada do histórico
        const history = [{
            id: 'h1',
            role: 'lead',
            content: result.rows[0].resumo,
            timestamp: new Date().toISOString()
        }];
        
        res.json(history);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar histórico' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
