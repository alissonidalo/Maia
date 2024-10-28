// index.js

// Importação de módulos necessários
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const https = require('https');
const ffmpeg = require('fluent-ffmpeg');
const { Readable } = require('stream');
const path = require('path');
require('dotenv').config();

// Carregar as chaves das APIs do arquivo .env
const DIFY_API_KEY = process.env.DIFY_API_KEY;
const DIFY_API_URL = process.env.DIFY_API_URL;
const GENNY_LOVO_API_KEY = process.env.GENNY_LOVO_API_KEY;
const GENNY_LOVO_API_URL = process.env.GENNY_LOVO_API_URL;

// Verificar se as chaves das APIs estão definidas
if (!DIFY_API_KEY) {
    console.error('Erro: DIFY_API_KEY não definida. Por favor, defina no arquivo .env.');
    process.exit(1);
}

if (!GENNY_LOVO_API_KEY) {
    console.error('Erro: GENNY_LOVO_API_KEY não definida. Por favor, defina no arquivo .env.');
    process.exit(1);
}

// Configuração do cliente WhatsApp
const client = new Client({
    authStrategy: new LocalAuth()
});

// Função para verificar se a consulta é significativa
function isMeaningfulQuery(text) {
    // Verifica se o texto não está vazio, não é apenas espaços e não é um nome de arquivo (ex: "document.pdf")
    return text && text.trim().length > 10 && !text.match(/^\d+\.\w+$/);
}

// Função para validar formatos suportados
function isSupportedFormat(mimetype, category) {
    // Extrair apenas a parte principal do MIME type, ignorando parâmetros
    const mime = mimetype.split(';')[0].trim().toLowerCase();

    const supportedFormats = {
        image: [
            'image/jpeg',
            'image/jpg',
            'image/png',
            'image/gif',
            'image/webp',
            'image/svg+xml'
        ],
        document: [
            'text/plain',
            'text/markdown',
            'application/pdf',
            'text/html',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'text/csv',
            'message/rfc822'
        ],
        audio: [
            'audio/mpeg',
            'audio/mp4',
            'audio/x-m4a',
            'audio/wav',
            'audio/webm',
            'audio/amr',
            'audio/ogg' // Suporta 'audio/ogg; codecs=opus'
        ],
        video: [
            'video/mp4',
            'video/quicktime',
            'video/mpeg',
            'audio/mpeg'
        ]
    };

    // Verificar se a categoria existe
    if (!supportedFormats[category]) {
        console.warn(`Categoria "${category}" não definida na função isSupportedFormat.`);
        return false;
    }

    return supportedFormats[category].includes(mime);
}

// Função para dividir texto em blocos de até 500 caracteres
function splitTextIntoBlocks(text, maxLength = 500) {
    const blocks = [];
    let currentBlock = '';

    const sentences = text.match(/[^.!?]+[.!?]+[\])'"`’”]*|.+/g);

    if (sentences) {
        for (const sentence of sentences) {
            if ((currentBlock + sentence).length > maxLength) {
                if (currentBlock.length > 0) {
                    blocks.push(currentBlock.trim());
                    currentBlock = '';
                }

                if (sentence.length > maxLength) {
                    // Dividir a sentença em pedaços menores
                    let start = 0;
                    while (start < sentence.length) {
                        let end = start + maxLength;
                        // Evitar cortar no meio de uma palavra
                        if (end < sentence.length) {
                            const lastSpace = sentence.lastIndexOf(' ', end);
                            if (lastSpace > start) {
                                end = lastSpace;
                            }
                        }
                        blocks.push(sentence.substring(start, end).trim());
                        start = end;
                    }
                } else {
                    currentBlock += sentence;
                }
            } else {
                currentBlock += sentence;
            }
        }

        if (currentBlock.trim().length > 0) {
            blocks.push(currentBlock.trim());
        }
    } else {
        // Se não conseguir dividir em sentenças, dividir simplesmente por caracteres
        let start = 0;
        while (start < text.length) {
            let end = start + maxLength;
            blocks.push(text.substring(start, end).trim());
            start = end;
        }
    }

    return blocks;
}

// Evento de geração do QR Code
client.on('qr', (qrData) => {
    console.log('QR Code recebido, gerando imagem...');

    // Gerar o QR Code e salvá-lo em um arquivo
    qrcode.toDataURL(qrData, (err, url) => {
        if (err) {
            console.error('Erro ao gerar o QR Code:', err);
            return;
        }
        // Extrair a parte base64 da URL
        const base64Data = url.replace(/^data:image\/png;base64,/, '');
        // Salvar o arquivo
        fs.writeFile('qrcode.png', base64Data, 'base64', (err) => {
            if (err) {
                console.error('Erro ao salvar o QR Code:', err);
            } else {
                console.log('QR Code salvo como qrcode.png');
            }
        });
    });
});

// Evento de autenticação
client.on('authenticated', () => {
    console.log('Autenticado com sucesso!');
});

// Evento de inicialização
client.on('ready', () => {
    console.log('Cliente está pronto!');
});

// Evento de recebimento de mensagem
client.on('message', async (message) => {
    console.log(`Mensagem recebida de ${message.from}: ${message.body || '<mídia>'}`);

    // Ignorar mensagens de status e de grupo
    if (message.from === 'status@broadcast' || message.from.includes('@g.us')) {
        console.log('Mensagem de status ou de grupo ignorada.');
        return;
    }

    // Lista de tipos de mensagens não suportadas que devem ser ignoradas
    const unsupportedMessageTypes = ['notification_template', 'e2e_notification'];

    if (unsupportedMessageTypes.includes(message.type)) {
        console.log(`Tipo de mensagem não suportado: ${message.type}. Ignorando.`);
        return; // Não processar nem enviar mensagens de erro
    }

    try {
        // Verificar o tipo de mensagem
        if (message.type === 'chat') {
            // Mensagem de texto
            await handleTextMessage(message);
        } else if (message.hasMedia) {
            // Mensagem com mídia
            await handleMediaMessage(message);
        } else {
            console.log('Tipo de mensagem não suportado:', message.type);
            client.sendMessage(message.from, 'Desculpe, este tipo de mensagem não é suportado.');
        }
    } catch (error) {
        console.error('Erro ao processar a mensagem:', error);
        client.sendMessage(message.from, 'Desculpe, ocorreu um erro ao processar sua mensagem.');
    }
});

// Função para lidar com mensagens de texto
async function handleTextMessage(message) {
    const userMessage = message.body;
    console.log('Processando mensagem de texto:', userMessage);

    // Verificar se o usuário solicitou uma resposta em áudio
    const userRequestedAudio = /responda em áudio|responda em audio|me responda em áudio|me responda em audio/i.test(userMessage);

    try {
        // Fazer requisição à API do Dify para obter a resposta do chat
        const response = await axios.post(`${DIFY_API_URL}/chat-messages`, {
            query: userMessage,
            inputs: {},
            user: message.from,
            response_mode: 'blocking'
        }, {
            headers: {
                'Authorization': `Bearer ${DIFY_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        console.log('Resposta da API Dify recebida:', response.data);

        const reply = response.data.answer;

        // Verificar se a resposta contém uma imagem ou arquivo em formato Markdown
        const imageMarkdownRegex = /!\[.*?\]\((.*?)\)/;
        const fileMarkdownRegex = /\[.*?\]\((.*?)\)/;

        if (imageMarkdownRegex.test(reply)) {
            // Resposta contém uma imagem
            await handleImageReply(message.from, reply);
        } else if (fileMarkdownRegex.test(reply)) {
            // Resposta contém um arquivo (como áudio)
            await handleFileReply(message.from, reply);
        } else {
            // Resposta contém apenas texto
            if (userRequestedAudio) {
                // Usuário solicitou áudio
                await sendVoiceReply(message.from, reply);
                console.log('Áudio enviado ao usuário conforme solicitado.');
            } else {
                // Enviar apenas o texto
                await client.sendMessage(message.from, reply);
                console.log('Resposta enviada ao usuário.');
            }
        }

    } catch (error) {
        console.error('Erro ao chamar a API do Dify:', error);

        if (error.response) {
            console.error('Erro na resposta da API:', error.response.data);

            if (error.response.data.code === 'invalid_param' && error.response.data.message.includes('content_policy_violation')) {
                client.sendMessage(message.from, 'Desculpe, sua mensagem não pôde ser processada devido a uma violação das políticas de conteúdo.');
            } else {
                client.sendMessage(message.from, 'Desculpe, ocorreu um erro ao processar sua mensagem.');
            }
        } else {
            client.sendMessage(message.from, 'Desculpe, ocorreu um erro ao processar sua mensagem.');
        }
    }
}

// Função para lidar com mensagens de mídia
async function handleMediaMessage(message) {
    const media = await message.downloadMedia();

    console.log('Mídia recebida:', media.filename || 'sem nome', 'Tipo:', media.mimetype);
    console.log('Texto da mensagem:', message.body);

    // Lista de tipos de mídia suportados
    const supportedMediaTypes = ['image', 'audio', 'video', 'document'];

    // Extrair o tipo principal da mídia
    const mediaType = media.mimetype.split('/')[0].toLowerCase();

    if (!supportedMediaTypes.includes(mediaType)) {
        console.log(`Tipo de mídia não suportado: ${mediaType}`);
        // Não enviar mensagem de erro para evitar múltiplas respostas
        return;
    }

    if (mediaType === 'image') {
        if (isSupportedFormat(media.mimetype, 'image')) {
            await processImageMessage(message, media);
        } else {
            console.log('Formato de imagem não suportado:', media.mimetype);
            // Não enviar mensagem de erro
        }
    } else if (mediaType === 'audio') {
        if (isSupportedFormat(media.mimetype, 'audio')) {
            await handleAudioMessage(message);
        } else {
            console.log('Formato de áudio não suportado:', media.mimetype);
            // Não enviar mensagem de erro
        }
    } else if (mediaType === 'video') {
        if (isSupportedFormat(media.mimetype, 'video')) {
            await handleVideoMessage(message, media);
        } else {
            console.log('Formato de vídeo não suportado:', media.mimetype);
            // Não enviar mensagem de erro
        }
    } else if (mediaType === 'document') {
        if (isSupportedFormat(media.mimetype, 'document')) {
            await handleDocumentMessage(message, media);
        } else {
            console.log('Formato de documento não suportado:', media.mimetype);
            // Não enviar mensagem de erro
        }
    } else {
        console.log('Tipo de mídia não suportado para processamento:', media.mimetype);
        // Não enviar mensagem de erro
    }
}

// Função para processar mensagens de imagem
async function processImageMessage(message, media) {
    try {
        // Extrair o texto (query) da mensagem
        const queryText = isMeaningfulQuery(message.body) ? message.body : "Descreva esta imagem.";
        console.log('Texto da consulta:', queryText);

        // Criar um FormData para upload da imagem
        const formData = new FormData();
        formData.append('file', Buffer.from(media.data, 'base64'), {
            filename: 'image.jpg',
            contentType: media.mimetype
        });
        formData.append('user', message.from);

        console.log('Enviando imagem para upload na API Dify...');

        // Fazer o upload da imagem para o Dify
        const uploadResponse = await axios.post(`${DIFY_API_URL}/files/upload`, formData, {
            headers: {
                'Authorization': `Bearer ${DIFY_API_KEY}`,
                ...formData.getHeaders()
            }
        });

        console.log('Imagem enviada com sucesso. ID do arquivo:', uploadResponse.data.id);

        const fileId = uploadResponse.data.id;

        // Chamar a API de chat com a imagem e a query do usuário
        const chatResponse = await axios.post(`${DIFY_API_URL}/chat-messages`, {
            query: queryText, // Utilizando o texto da consulta
            inputs: {},
            user: message.from,
            response_mode: 'blocking',
            files: [
                {
                    type: 'image',
                    transfer_method: 'local_file',
                    upload_file_id: fileId
                }
            ]
        }, {
            headers: {
                'Authorization': `Bearer ${DIFY_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        console.log('Resposta da API Dify para imagem recebida:', chatResponse.data);

        const reply = chatResponse.data.answer;

        // Verificar se a resposta contém uma imagem ou arquivo
        const imageMarkdownRegex = /!\[.*?\]\((.*?)\)/;
        const fileMarkdownRegex = /\[.*?\]\((.*?)\)/;

        if (imageMarkdownRegex.test(reply)) {
            // Processar imagem
            await handleImageReply(message.from, reply, queryText);
        } else if (fileMarkdownRegex.test(reply)) {
            // Processar arquivo
            await handleFileReply(message.from, reply, queryText);
        } else {
            // Enviar apenas o texto
            await client.sendMessage(message.from, reply);
            console.log('Resposta enviada ao usuário.');
        }

    } catch (error) {
        console.error('Erro ao processar a imagem:', error);

        if (error.response) {
            console.error('Erro na resposta da API:', error.response.data);

            if (error.response.data.code === 'invalid_param' && error.response.data.message.includes('content_policy_violation')) {
                client.sendMessage(message.from, 'Desculpe, sua imagem não pôde ser processada devido a uma violação das políticas de conteúdo.');
            } else if (error.response.data.code === 'invalid_param' && error.response.data.message.includes('query is required')) {
                client.sendMessage(message.from, 'Desculpe, não foi possível processar a imagem porque a consulta está vazia.');
            } else {
                // Evitar enviar mensagens de erro para tipos não suportados
                // client.sendMessage(message.from, 'Desculpe, ocorreu um erro ao processar sua imagem.');
            }
        } else {
            // Evitar enviar mensagens de erro para tipos não suportados
            // client.sendMessage(message.from, 'Desculpe, ocorreu um erro ao processar sua imagem.');
        }
    }
}

// Função para lidar com áudios recebidos e converter para texto
async function handleAudioMessage(message) {
    const media = await message.downloadMedia();

    console.log('Áudio recebido:', media.filename || 'audio', 'Tipo:', media.mimetype);
    console.log('Texto da consulta:', message.body);

    try {
        // Definir o texto da consulta
        let queryText = isMeaningfulQuery(message.body) ? message.body : "";
        console.log('Texto da consulta:', queryText);

        // Converter OGG para WAV
        const oggBuffer = Buffer.from(media.data, 'base64');
        const wavBuffer = await convertOggToWav(oggBuffer);

        // **Código Temporário para Salvar o Buffer como Arquivo**
        const tempOggPath = path.join(__dirname, 'temp_audio.ogg');
        fs.writeFileSync(tempOggPath, oggBuffer);
        console.log(`Buffer de áudio salvo em ${tempOggPath}`);

        // Criar um FormData para upload do áudio
        const formData = new FormData();
        formData.append('file', wavBuffer, {
            filename: 'audio.wav',
            contentType: 'audio/wav'
        });
        formData.append('user', message.from);

        console.log('Enviando áudio para conversão de voz para texto na API Dify...');

        // Enviar o áudio para o Dify para conversão de voz para texto
        const audioResponse = await axios.post(`${DIFY_API_URL}/audio-to-text`, formData, {
            headers: {
                'Authorization': `Bearer ${DIFY_API_KEY}`,
                ...formData.getHeaders()
            }
        });

        console.log('Áudio transcrito com sucesso:', audioResponse.data.text);

        const transcribedText = audioResponse.data.text;

        // Processar o texto transcrito com a API de chat
        const chatResponse = await axios.post(`${DIFY_API_URL}/chat-messages`, {
            query: transcribedText,
            inputs: {},
            user: message.from,
            response_mode: 'blocking'
        }, {
            headers: {
                'Authorization': `Bearer ${DIFY_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        console.log('Resposta da API Dify para áudio recebido:', chatResponse.data);

        const reply = chatResponse.data.answer;

        // Verificar se a resposta contém um arquivo (como áudio)
        const fileMarkdownRegex = /\[.*?\]\((.*?)\)/;

        if (fileMarkdownRegex.test(reply)) {
            // Processar arquivo (como áudio)
            await handleFileReply(message.from, reply, queryText);
        } else {
            // Enviar resposta em áudio
            await sendVoiceReply(message.from, reply);
            console.log('Resposta em áudio enviada ao usuário.');
        }

    } catch (error) {
        console.error('Erro ao processar o áudio:', error);

        if (error.response) {
            console.error('Erro na resposta da API:', error.response.data);

            if (error.response.data.code === 'invalid_param' && error.response.data.message.includes('content_policy_violation')) {
                client.sendMessage(message.from, 'Desculpe, seu áudio não pôde ser processado devido a uma violação das políticas de conteúdo.');
            } else if (error.response.data.code === 'invalid_param' && error.response.data.message.includes('query is required')) {
                client.sendMessage(message.from, 'Desculpe, não foi possível processar o áudio porque a consulta está vazia.');
            } else {
                client.sendMessage(message.from, 'Desculpe, ocorreu um erro ao processar seu áudio.');
            }
        } else {
            client.sendMessage(message.from, 'Desculpe, ocorreu um erro ao processar seu áudio.');
        }
    }
}

// Função para lidar com vídeos
async function handleVideoMessage(message, media) {
    try {
        // Definir o texto da consulta
        let queryText = isMeaningfulQuery(message.body) ? message.body : "Analise este vídeo.";
        console.log('Texto da consulta:', queryText);

        // Criar um FormData para upload do vídeo
        const formData = new FormData();
        formData.append('file', Buffer.from(media.data, 'base64'), {
            filename: media.filename || 'video.mp4',
            contentType: media.mimetype
        });
        formData.append('user', message.from);

        console.log('Enviando vídeo para upload na API Dify...');

        // Fazer o upload do vídeo para o Dify
        const uploadResponse = await axios.post(`${DIFY_API_URL}/files/upload`, formData, {
            headers: {
                'Authorization': `Bearer ${DIFY_API_KEY}`,
                ...formData.getHeaders()
            }
        });

        console.log('Vídeo enviado com sucesso. ID do arquivo:', uploadResponse.data.id);

        const fileId = uploadResponse.data.id;

        // Chamar a API de chat com o vídeo e a query do usuário
        const chatResponse = await axios.post(`${DIFY_API_URL}/chat-messages`, {
            query: queryText,
            inputs: {},
            user: message.from,
            response_mode: 'blocking',
            files: [
                {
                    type: 'video',
                    transfer_method: 'local_file',
                    upload_file_id: fileId
                }
            ]
        }, {
            headers: {
                'Authorization': `Bearer ${DIFY_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        console.log('Resposta da API Dify para vídeo recebido:', chatResponse.data);

        const reply = chatResponse.data.answer;

        // Enviar a resposta para o usuário
        await client.sendMessage(message.from, reply);
        console.log('Resposta enviada ao usuário.');

    } catch (error) {
        console.error('Erro ao processar o vídeo:', error);

        if (error.response) {
            console.error('Erro na resposta da API:', error.response.data);

            if (error.response.data.code === 'invalid_param' && error.response.data.message.includes('content_policy_violation')) {
                client.sendMessage(message.from, 'Desculpe, seu vídeo não pôde ser processado devido a uma violação das políticas de conteúdo.');
            } else if (error.response.data.code === 'invalid_param' && error.response.data.message.includes('query is required')) {
                client.sendMessage(message.from, 'Desculpe, não foi possível processar o vídeo porque a consulta está vazia.');
            } else {
                client.sendMessage(message.from, 'Desculpe, ocorreu um erro ao processar seu vídeo.');
            }
        } else {
            client.sendMessage(message.from, 'Desculpe, ocorreu um erro ao processar seu vídeo.');
        }
    }
}

// Função para lidar com documentos (PDF, TXT, etc.)
async function handleDocumentMessage(message, media) {
    try {
        // Extrair o texto (query) da mensagem
        let queryText = isMeaningfulQuery(message.body) ? message.body : "Resuma este documento.";
        console.log('Texto da consulta:', queryText);

        // Criar um FormData para upload do documento
        const formData = new FormData();
        formData.append('file', Buffer.from(media.data, 'base64'), {
            filename: media.filename || 'document.pdf',
            contentType: media.mimetype
        });
        formData.append('user', message.from);

        console.log('Enviando documento para upload na API Dify...');

        // Fazer o upload do documento para o Dify
        const uploadResponse = await axios.post(`${DIFY_API_URL}/files/upload`, formData, {
            headers: {
                'Authorization': `Bearer ${DIFY_API_KEY}`,
                ...formData.getHeaders()
            }
        });

        console.log('Documento enviado com sucesso. ID do arquivo:', uploadResponse.data.id);

        const fileId = uploadResponse.data.id;

        // Chamar a API de chat com o documento e a query do usuário
        const chatResponse = await axios.post(`${DIFY_API_URL}/chat-messages`, {
            query: queryText, // Utilizando o texto da consulta
            inputs: {},
            user: message.from,
            response_mode: 'blocking',
            files: [
                {
                    type: 'document',
                    transfer_method: 'local_file',
                    upload_file_id: fileId
                }
            ]
        }, {
            headers: {
                'Authorization': `Bearer ${DIFY_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        console.log('Resposta da API Dify para documento recebido:', chatResponse.data);

        const reply = chatResponse.data.answer;

        // Enviar a resposta para o usuário
        await client.sendMessage(message.from, reply);
        console.log('Resposta enviada ao usuário.');

    } catch (error) {
        console.error('Erro ao processar o documento:', error);

        if (error.response) {
            console.error('Erro na resposta da API:', error.response.data);

            if (error.response.data.code === 'invalid_param' && error.response.data.message.includes('content_policy_violation')) {
                client.sendMessage(message.from, 'Desculpe, seu documento não pôde ser processado devido a uma violação das políticas de conteúdo.');
            } else if (error.response.data.code === 'invalid_param' && error.response.data.message.includes('query is required')) {
                client.sendMessage(message.from, 'Desculpe, não foi possível processar o documento porque a consulta está vazia.');
            } else {
                client.sendMessage(message.from, 'Desculpe, ocorreu um erro ao processar seu documento.');
            }
        } else {
            client.sendMessage(message.from, 'Desculpe, ocorreu um erro ao processar seu documento.');
        }
    }
}

// Função para processar respostas que contêm imagens
async function handleImageReply(to, reply, queryText) {
    const imageMarkdownRegex = /!\[.*?\]\((.*?)\)/;
    const match = reply.match(imageMarkdownRegex);

    if (match && match[1]) {
        const imageUrl = match[1];
        console.log('URL da imagem extraída:', imageUrl);

        try {
            // Baixar a imagem
            const imageBuffer = await downloadFile(imageUrl);

            // Determinar o tipo MIME da imagem com base na extensão
            let mimeType = 'image/png'; // Padrão
            if (imageUrl.endsWith('.jpg') || imageUrl.endsWith('.jpeg')) {
                mimeType = 'image/jpeg';
            } else if (imageUrl.endsWith('.gif')) {
                mimeType = 'image/gif';
            } else if (imageUrl.endsWith('.webp')) {
                mimeType = 'image/webp';
            } else if (imageUrl.endsWith('.svg')) {
                mimeType = 'image/svg+xml';
            }

            // Criar um objeto de mídia para enviar como imagem
            const media = new MessageMedia(mimeType, imageBuffer.toString('base64'));

            // Enviar a imagem para o usuário
            await client.sendMessage(to, media);
            console.log('Imagem enviada ao usuário.');

            // Opcional: Enviar também o texto alternativo (se houver)
            const altText = reply.replace(imageMarkdownRegex, '').trim();
            if (altText) {
                await client.sendMessage(to, altText);
            }
        } catch (error) {
            console.error('Erro ao baixar ou enviar a imagem:', error);
            client.sendMessage(to, 'Desculpe, ocorreu um erro ao enviar a imagem.');
        }
    } else {
        console.log('Nenhuma imagem encontrada na resposta.');
    }
}

// Função para processar respostas que contêm arquivos (como áudio)
async function handleFileReply(to, reply, queryText) {
    // Regex para extrair o URL do arquivo
    const fileMarkdownRegex = /\[.*?\]\((.*?)\)/;
    const match = reply.match(fileMarkdownRegex);

    if (match && match[1]) {
        const fileUrl = match[1];
        console.log('URL do arquivo extraído:', fileUrl);

        try {
            // Baixar o arquivo
            const fileBuffer = await downloadFile(fileUrl);

            // Verificar a extensão do arquivo
            const urlObj = new URL(fileUrl);
            const pathname = urlObj.pathname;
            const fileExtension = pathname.split('.').pop().split('?')[0].toLowerCase();

            // Converter o arquivo para o formato suportado pelo WhatsApp
            let convertedBuffer;
            if (fileExtension === 'wav') {
                convertedBuffer = await convertWavToOgg(fileBuffer);
            } else if (['mp3', 'm4a', 'webm', 'amr'].includes(fileExtension)) {
                convertedBuffer = await convertMp3ToOgg(fileBuffer);
            } else if (fileExtension === 'ogg') {
                // Caso o áudio já esteja em OGG, não precisa converter
                convertedBuffer = fileBuffer;
            } else {
                console.error('Formato de áudio não suportado para conversão.');
                // Evitar enviar mensagem de erro
                // client.sendMessage(to, 'Desculpe, não consegui processar o áudio recebido.');
                return;
            }

            // Criar um objeto de mídia para enviar como áudio
            const media = new MessageMedia('audio/ogg; codecs=opus', convertedBuffer.toString('base64'));

            // Enviar o áudio para o usuário como mensagem de voz
            await client.sendMessage(to, media, { sendAudioAsVoice: true });
            console.log('Áudio enviado ao usuário como mensagem de voz.');
        } catch (error) {
            console.error('Erro ao baixar ou enviar o arquivo:', error);
            // Evitar enviar mensagem de erro
            // client.sendMessage(to, 'Desculpe, ocorreu um erro ao enviar o arquivo.');
        }
    } else {
        console.log('Nenhum arquivo encontrado na resposta.');
    }
}

// Função para converter WAV para OGG com codec Opus
async function convertWavToOgg(wavBuffer) {
    return new Promise((resolve, reject) => {
        const readableStream = new Readable();
        readableStream.push(wavBuffer);
        readableStream.push(null);

        const chunks = [];

        ffmpeg(readableStream)
            .inputFormat('wav')
            .format('ogg')
            .audioCodec('libopus')
            .on('error', (err) => {
                console.error('Erro na conversão de áudio:', err);
                reject(err);
            })
            .on('end', () => {
                console.log('Conversão de áudio concluída.');
                resolve(Buffer.concat(chunks));
            })
            .pipe()
            .on('data', (chunk) => {
                chunks.push(chunk);
            });
    });
}

// Função para converter MP3 para OGG com codec Opus
async function convertMp3ToOgg(mp3Buffer) {
    return new Promise((resolve, reject) => {
        const readableStream = new Readable();
        readableStream.push(mp3Buffer);
        readableStream.push(null);

        const chunks = [];

        ffmpeg(readableStream)
            .inputFormat('mp3')
            .format('ogg')
            .audioCodec('libopus')
            .on('error', (err) => {
                console.error('Erro na conversão de áudio:', err);
                reject(err);
            })
            .on('end', () => {
                console.log('Conversão de áudio concluída.');
                resolve(Buffer.concat(chunks));
            })
            .pipe()
            .on('data', (chunk) => {
                chunks.push(chunk);
            });
    });
}

// Função para converter OGG Opus para WAV
async function convertOggToWav(oggBuffer) {
    return new Promise((resolve, reject) => {
        const readableStream = new Readable();
        readableStream.push(oggBuffer);
        readableStream.push(null);

        const chunks = [];

        ffmpeg(readableStream)
            .inputFormat('ogg')
            .format('wav')
            .on('error', (err) => {
                console.error('Erro na conversão de áudio:', err);
                reject(err);
            })
            .on('end', () => {
                console.log('Conversão de áudio concluída.');
                resolve(Buffer.concat(chunks));
            })
            .pipe()
            .on('data', (chunk) => {
                chunks.push(chunk);
            });
    });
}

// Função para baixar um arquivo a partir de uma URL
async function downloadFile(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Falha ao baixar arquivo. Status Code: ${res.statusCode}`));
                res.resume(); // Consumir os dados para liberar memória
                return;
            }

            const data = [];
            res.on('data', (chunk) => data.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(data);
                resolve(buffer);
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

// Função para concatenar buffers de áudio OGG Opus usando ffmpeg
async function concatenateAudioBuffers(buffers) {
    return new Promise((resolve, reject) => {
        const tempFiles = buffers.map((buffer, index) => path.join(__dirname, `temp_audio_${index}.ogg`));

        // Salvar os buffers como arquivos temporários
        buffers.forEach((buffer, index) => {
            fs.writeFileSync(tempFiles[index], buffer);
        });

        // Criar uma lista de arquivos para concatenar
        const fileListPath = path.join(__dirname, 'audio_files.txt');
        const fileListContent = tempFiles.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(fileListPath, fileListContent);

        // Usar ffmpeg para concatenar os arquivos
        ffmpeg()
            .input(fileListPath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .outputOptions(['-c', 'copy'])
            .save(path.join(__dirname, 'final_audio.ogg'))
            .on('end', () => {
                console.log('Áudio concatenado com sucesso.');
                // Ler o arquivo final
                const finalBuffer = fs.readFileSync(path.join(__dirname, 'final_audio.ogg'));

                // Limpar arquivos temporários
                tempFiles.forEach(file => fs.unlinkSync(file));
                fs.unlinkSync(fileListPath);
                fs.unlinkSync(path.join(__dirname, 'final_audio.ogg'));

                resolve(finalBuffer);
            })
            .on('error', (err) => {
                console.error('Erro ao concatenar os arquivos de áudio:', err);
                // Limpar arquivos temporários mesmo em caso de erro
                tempFiles.forEach(file => fs.unlinkSync(file));
                fs.unlinkSync(fileListPath);
                reject(err);
            });
    });
}

// Função para converter texto em áudio e enviar para o usuário usando Genny Lovo
async function sendVoiceReply(to, text) {
    console.log('Convertendo texto em áudio:', text);

    // Dividir o texto em blocos de até 500 caracteres
    const textBlocks = splitTextIntoBlocks(text, 500);
    console.log(`Texto dividido em ${textBlocks.length} blocos.`);

    const audioBuffers = [];

    for (let i = 0; i < textBlocks.length; i++) {
        const block = textBlocks[i];
        console.log(`Processando bloco ${i + 1}: ${block}`);

        const ttsEndpoint = `${GENNY_LOVO_API_URL}/tts/sync`; // Endpoint corrigido
        console.log('Endpoint de Text-to-Speech Construído:', ttsEndpoint);

        try {
            const ttsResponse = await axios.post(ttsEndpoint, {
                text: block,
                speaker: "63b409bb241a82001d51c710", // ID da voz "Maria Cardoso"
                speed: 1.25
            }, {
                headers: {
                    'X-API-KEY': GENNY_LOVO_API_KEY,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                responseType: 'json' // Para receber dados JSON
            });

            console.log('Resposta da API TTS:', ttsResponse.data);

            // Verificar se a resposta contém a URL do áudio
            if (
                ttsResponse.data.data &&
                Array.isArray(ttsResponse.data.data) &&
                ttsResponse.data.data.length > 0 &&
                Array.isArray(ttsResponse.data.data[0].urls) &&
                ttsResponse.data.data[0].urls.length > 0
            ) {
                const audioUrl = ttsResponse.data.data[0].urls[0];
                console.log(`URL do áudio gerado para o bloco ${i + 1}:`, audioUrl);

                // Baixar o áudio a partir da URL fornecida
                const audioBuffer = await downloadFile(audioUrl);

                // Converter o áudio para OGG com codec Opus
                const convertedBuffer = await convertWavToOgg(audioBuffer);

                audioBuffers.push(convertedBuffer);
            } else {
                console.error('Resposta da API TTS não contém URLs de áudio.');
                client.sendMessage(to, 'Desculpe, ocorreu um erro ao gerar o áudio.');
                return;
            }

        } catch (error) {
            console.error('Erro ao converter texto em áudio:', error);

            if (error.response) {
                console.error('Erro na resposta da API:', error.response.data);
                client.sendMessage(to, 'Desculpe, ocorreu um erro ao converter o texto em áudio.');
            } else {
                client.sendMessage(to, 'Desculpe, ocorreu um erro ao converter o texto em áudio.');
            }
            return;
        }
    }

    try {
        // Concatenar todos os buffers de áudio em um único buffer
        const concatenatedBuffer = await concatenateAudioBuffers(audioBuffers);

        // Criar um objeto de mídia para enviar como áudio
        const media = new MessageMedia('audio/ogg; codecs=opus', concatenatedBuffer.toString('base64'));

        // Enviar o áudio para o usuário como mensagem de voz
        await client.sendMessage(to, media, { sendAudioAsVoice: true });
        console.log('Áudio concatenado enviado ao usuário.');
    } catch (error) {
        console.error('Erro ao concatenar ou enviar o áudio:', error);
        client.sendMessage(to, 'Desculpe, ocorreu um erro ao enviar o áudio.');
    }
}

// Inicializar o cliente
client.initialize();
console.log('Inicializando o cliente WhatsApp...'); 
