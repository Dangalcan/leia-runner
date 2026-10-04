const express = require('express');
const router = express.Router();
const leiasController = require('../controllers/leiasController');
const modelsController = require('../controllers/modelsController');
const evaluationController = require('../controllers/evaluationController');
const cacheController = require('../controllers/cacheController');
const transcriptionController = require('../controllers/transcriptionController');
const problemGeneratorController = require('../controllers/problemGeneratorController');
const behaviourGeneratorController = require('../controllers/behaviourGeneratorController');
const problemChatController = require('../controllers/problemChatController');
const supervisorController = require('../controllers/supervisorController');
const imageGenerationController = require('../controllers/imageGenerationController');
const multiLeiasController = require('../controllers/multiLeiasController');
const multer = require('multer');
const { bearerAuth } = require('../utils/auth');

// In-memory PDF uploads for the problem-chat assistant (forwarded to OpenAI).
const uploadPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Aplicar middleware de autenticación a todas las rutas
router.use(bearerAuth);

// Endpoint para crear una nueva instancia de LEIA
router.post('/leias', leiasController.createLeia);

// Endpoint para enviar mensajes a LEIA
router.post('/leias/:sessionId/messages', leiasController.sendLeiaMessage);

// Text-only MultiLEIA runtime. Each actor gets an isolated provider session;
// the runtime traverses an implicit graph and returns the public messages
// generated before control goes back to the participant.
router.post('/multi-leias', multiLeiasController.createMultiLeia);
router.get('/multi-leias/:sessionId', multiLeiasController.getMultiLeiaState);
router.post('/multi-leias/:sessionId/messages', multiLeiasController.sendMultiLeiaMessage);
router.post('/multi-leias/:sessionId/messages/stream', multiLeiasController.streamMultiLeiaMessage);

// Endpoint para listar los modelos disponibles
router.get('/models', modelsController.listModels);

router.post('/evaluation', bearerAuth, evaluationController.evaluateSolution);

// Endpoints para gestión de caché
router.delete('/cache/purge', cacheController.purgeCache);
router.get('/cache/stats', cacheController.getCacheStats);

// Endpoints para transcripciones
router.post('/transcriptions/generate', transcriptionController.generateTranscription);

// Endpoint para generación de problemas con IA
router.post('/problems/generate', problemGeneratorController.generateProblem);
router.post('/behaviours/generate', behaviourGeneratorController.generateBehaviour);

// Endpoints para generación de imagenes con IA
router.post('/avatars/personas/generate', imageGenerationController.generatePersonaAvatar);
router.post('/avatars/problems/generate', imageGenerationController.generateProblemAvatar);
router.post('/avatars/leias/generate', imageGenerationController.generateLeiaAvatar);
router.post('/infographics/generate', imageGenerationController.generateInfographic);

// Problem-chat assistant (design-time): attach PDFs, chat; tools are executed in the FE.
router.post('/problems/chat/session', problemChatController.openProblemChat);
router.post('/problems/chat/:chatId/files', uploadPdf.single('file'), problemChatController.uploadProblemChatFile);
router.post('/problems/chat/:chatId/messages', problemChatController.sendProblemChatMessage);

// Background supervisor (stateless): observe an activity transcript window and
// return flags (+ optional student nudge). Called fire-and-forget by the workbench.
router.post('/supervisor', supervisorController.observe);

module.exports = router;
