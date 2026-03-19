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

// Inicialização do Banco de Dados (Tabela de Histórico Permanente)
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS historico_conversas (
                id SERIAL PRIMARY KEY,
                instancia_vendedor TEXT,
                remote_jid TEXT,
                content TEXT,
                role TEXT, -- 'lead' ou 'vendedor'
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('--- [DB] Tabela de histórico verificada/criada! ---');
    } catch (err) {
        console.error('--- [DB ERROR] Erro ao criar tabela de histórico:', err);
    }
}
initDB();

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

const normalizeId = (id) => id ? id.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '_') : '';

// --- Rota da Diretiva Executiva IA ---
app.get('/diretiva/:vendedor', async (req, res) => {
    try {
        const { vendedor } = req.params;
        const normalizedVendedor = normalizeId(vendedor);

        const result = await pool.query(
            'SELECT * FROM leads_analisados WHERE instancia_vendedor = $1 ORDER BY id DESC LIMIT 20',
            [normalizedVendedor]
        );
        const leads = result.rows;

        if (leads.length === 0) {
            return res.json({ diretiva: `Nenhum lead encontrado para [${normalizedVendedor}].` });
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

        const prompt = `Você é um diretor comercial sênior da Greatek. Analise o vendedor ${normalizedVendedor} com base nos seguintes leads:\n${leadsTexto}\n
        Gere uma Diretiva Executiva com: PONTOS FORTES, GAPS CRÍTICOS, PRODUTOS SUGERIDOS e PLANO DE AÇÃO. Seja direto e executivo.`;

        const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
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

        if (geminiData.error) {
            console.error('[Gemini API Error]', geminiData.error);
            return res.status(500).json({ diretiva: `Erro na IA: ${geminiData.error.message}` });
        }

        const diretiva = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
        res.json({ diretiva: diretiva || 'A IA não gerou conteúdo.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao gerar diretiva executiva.' });
    }
});

// Configurações da EvolutionAPI (para buscar histórico)
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-234a.up.railway.app';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '8A0B3E736A0F-49B5-8A35-99E4D699907C';

// --- WEBHOOK: Recebe mensagens da EvolutionAPI e processa com IA ---
app.post('/webhook', async (req, res) => {
    try {
        const event = req.body;
        
        if (event.event !== 'messages.upsert') {
            return res.status(200).send('Event ignored');
        }

        const instance = event.instance;
        const fromMe = event.data?.key?.fromMe;
        const pushName = event.data?.pushName || 'Desconhecido';
        const phone = event.data?.key?.remoteJid?.split('@')[0] || '';
        const remoteJid = event.data?.key?.remoteJid;
        const messageText = event.data?.message?.conversation || 
                            event.data?.message?.extendedTextMessage?.text || 
                            'Mensagem de mídia';

        console.log(`[Webhook] Mensagem de ${phone} (${fromMe ? 'Vendedor' : 'Lead'}) na instância ${instance}`);

        // 1. SALVAR NO HISTÓRICO PERMANENTE (Tudo o que entra e sai)
        const historyQuery = `
            INSERT INTO historico_conversas (instancia_vendedor, remote_jid, content, role)
            VALUES ($1, $2, $3, $4);
        `;
        await pool.query(historyQuery, [instance, remoteJid, messageText, fromMe ? 'vendedor' : 'lead']);

        // 2. SE FOR MENSAGEM DO VENDEDOR, APENAS ARQUIVAMOS E PARAMOS AQUI
        if (fromMe) {
            return res.status(200).send('Message archived');
        }

        // 3. SE FOR LEAD, BUSCAR CONTEXTO PARA ANÁLISE IA
        let historicoTexto = "Nenhum histórico anterior.";
        try {
            // Busca os últimos 15 do banco local (mais rápido que chamar API externa toda hora)
            const localHist = await pool.query(
                'SELECT role, content FROM historico_conversas WHERE remote_jid = $1 ORDER BY id DESC LIMIT 15',
                [remoteJid]
            );
            if (localHist.rows.length > 0) {
                historicoTexto = localHist.rows
                    .map(m => `${m.role === 'vendedor' ? 'Vendedor' : 'Lead'}: ${m.content}`)
                    .reverse()
                    .join('\n');
            }
        } catch (hErr) {
            console.error('[History Fetch Error]', hErr.message);
        }

        // 4. Chamar Gemini para analisar o Lead com Contexto
        const promptAnalysis = `Você é um analista comercial sênior da Greatek. 
        Analise a conversa abaixo e retorne um JSON puro.
        
        HISTÓRICO RECENTE:
        ${historicoTexto}
        
        MENSAGEM ATUAL:
        "${messageText}"
        
        CAMPOS REQUERIDOS:
        - nome_empresa, urgencia, resumo, resumo_ia (estratégico), interesse_lead, produto_ofertado, nome_lead, objecoes, gaps, probabilidade (0-100), temperatura_lead, proximo_passo.`;

        const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
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
        
        if (geminiData.error) {
            console.error('[Gemini Webhook Error]', geminiData.error);
            // Salva apenas o básico se a IA falhar
            await pool.query(`
                INSERT INTO leads_analisados (instancia_vendedor, telefone, nome_lead, resumo)
                VALUES ($1, $2, $3, $4) ON CONFLICT (telefone) DO UPDATE SET resumo = EXCLUDED.resumo;
            `, [instance, phone, pushName, messageText]);
            return res.status(200).send('Archived without analysis due to AI error');
        }

        let rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        rawText = rawText.replace(/```json|```/g, '').trim();
        
        let aiResponse;
        try {
            aiResponse = JSON.parse(rawText);
        } catch (e) {
            console.error('[JSON Parse Error]', rawText);
            throw new Error('Falha ao processar resposta da IA');
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

// --- Rota para histórico de conversa (Real e Permanente) ---
app.get('/leads/:id/historico', async (req, res) => {
    try {
        const { id } = req.params;
        
        // 1. Buscar o telefone do lead
        const leadRes = await pool.query('SELECT telefone FROM leads_analisados WHERE id = $1', [id]);
        if (leadRes.rows.length === 0) return res.status(404).json({ error: 'Lead não encontrado' });
        
        const phone = leadRes.rows[0].telefone;
        const remoteJid = `${phone}@s.whatsapp.net`;

        // 2. Buscar histórico no banco local
        const historyRes = await pool.query(
            'SELECT role, content, timestamp FROM historico_conversas WHERE remote_jid = $1 ORDER BY timestamp ASC',
            [remoteJid]
        );
        
        res.json(historyRes.rows.map((m, i) => ({
            id: `h-${i}`,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp
        })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao buscar histórico real' });
    }
});

// --- Rota para Sincronizar Histórico Retroativo do EvolutionAPI ---
app.get('/sync-history/:vendedor', async (req, res) => {
    try {
        const { vendedor } = req.params; // instancia
        const leadsRes = await pool.query('SELECT telefone FROM leads_analisados WHERE instancia_vendedor = $1', [vendedor]);
        
        let totalSincronizado = 0;

        for (const lead of leadsRes.rows) {
            const remoteJid = `${lead.telefone}@s.whatsapp.net`;
            try {
                const evRes = await fetch(`${EVOLUTION_API_URL}/chat/fetchMessages`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY },
                    body: JSON.stringify({ instance: vendedor, where: { remoteJid }, limit: 50 })
                });
                const messages = await evRes.json();
                
                if (Array.isArray(messages)) {
                    for (const m of messages) {
                        if (!m.message) continue;
                        const text = m.message.conversation || m.message.extendedTextMessage?.text || 'Mídia';
                        const role = m.key.fromMe ? 'vendedor' : 'lead';
                        const ts = new Date(m.messageTimestamp * 1000);

                        await pool.query(`
                            INSERT INTO historico_conversas (instancia_vendedor, remote_jid, content, role, timestamp)
                            VALUES ($1, $2, $3, $4, $5)
                            ON CONFLICT DO NOTHING; -- Ignora se já existir
                        `, [vendedor, remoteJid, text, role, ts]);
                        totalSincronizado++;
                    }
                }
            } catch (e) {
                console.warn(`[Sync] Falha para ${remoteJid}:`, e.message);
            }
        }
        res.json({ success: true, messagesSynced: totalSincronizado });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro no sincronismo retroativo' });
    }
});

// --- Rota Manual para Reanalisar Todos os Leads sem IA (Super Robusta) ---
app.get('/reanalyze-all', async (req, res) => {
    try {
        console.log('--- [MASS REANALYZE START] ---');
        const leadsRes = await pool.query(`
            SELECT id, telefone, resumo, instancia_vendedor 
            FROM leads_analisados 
            WHERE resumo_ia IS NULL OR resumo_ia = '' OR resumo_ia LIKE '%Sem resumo%'
            ORDER BY id DESC LIMIT 15
        `);
        
        let logs = [];
        let atualizados = 0;

        for (const lead of leadsRes.rows) {
            try {
                const remoteJid = `${lead.telefone}@s.whatsapp.net`;
                const instance = lead.instancia_vendedor;

                console.log(`[Sync] ${lead.telefone}...`);
                const evRes = await fetch(`${EVOLUTION_API_URL}/chat/fetchMessages`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY },
                    body: JSON.stringify({ instance, where: { remoteJid }, limit: 15 })
                });
                const messages = await evRes.json();
                
                if (Array.isArray(messages)) {
                    for (const m of messages) {
                        if (!m.message) continue;
                        const text = m.message.conversation || m.message.extendedTextMessage?.text || 'Mídia';
                        const role = m.key.fromMe ? 'vendedor' : 'lead';
                        const ts = m.messageTimestamp ? new Date(m.messageTimestamp * 1000) : new Date();

                        await pool.query(`
                            INSERT INTO historico_conversas (instancia_vendedor, remote_jid, content, role, timestamp)
                            VALUES ($1, $2, $3, $4, $5)
                            ON CONFLICT DO NOTHING;
                        `, [instance, remoteJid, text, role, ts]);
                    }
                }

                const localHist = await pool.query(
                    'SELECT role, content FROM historico_conversas WHERE remote_jid = $1 ORDER BY timestamp DESC LIMIT 20',
                    [remoteJid]
                );
                
                const context = localHist.rows.length > 0 
                  ? localHist.rows.map(m => `${m.role}: ${m.content}`).reverse().join('\n')
                  : `(Apenas mensagem inicial): ${lead.resumo}`;

                const prompt = `Analise este lead e retorne APENAS um JSON válido.
                CONVERSA:\n${context}\n
                JSON SCHEMA: { "resumo_ia": "curto e estratégico", "interesse_lead": "produto", "urgencia": "baixa/media/alta", "nome_lead": "nome completo", "probabilidade": 0-100, "temperatura_lead": "Frio/Morno/Quente", "proximo_passo": "ação" }`;

                const geminiRes = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: prompt }] }],
                            generationConfig: { temperature: 0.2 }
                        })
                    }
                );
                const geminiData = await geminiRes.json();
                if (geminiData.error) throw new Error(geminiData.error.message);

                let rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
                rawText = rawText.replace(/```json|```/g, '').trim();
                const ai = JSON.parse(rawText);

                await pool.query(`
                    UPDATE leads_analisados 
                    SET 
                        resumo_ia = $1, interesse_lead = $2, urgencia = $3, 
                        probabilidade = $4, temperatura_lead = $5, proximo_passo = $6,
                        nome_lead = $7, resumo = $8
                    WHERE id = $9
                `, [
                    ai.resumo_ia, ai.interesse_lead || 'Geral', ai.urgencia || 'baixa',
                    parseInt(ai.probabilidade) || 0, ai.temperatura_lead || 'Frio', ai.proximo_passo || 'Aguardar',
                    ai.nome_lead || lead.id, ai.resumo_ia || lead.resumo,
                    lead.id
                ]);
                
                atualizados++;
                logs.push(`ID ${lead.id} OK: ${ai.resumo_ia?.substring(0, 30)}...`);
            } catch (err) {
                logs.push(`ID ${lead.id} FAIL: ${err.message}`);
            }
        }
        res.json({ success: true, updatedCount: atualizados, details: logs });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
