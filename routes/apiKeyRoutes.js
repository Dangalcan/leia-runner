const express = require('express');
const router = express.Router();
const { bearerAuth } = require('../utils/auth');
const apiKeyController = require('../controllers/apiKeyController');
// Aplicar middleware de autenticación a todas las rutas
router.use(bearerAuth);
router.post('/revoke', apiKeyController.revokeApiKey);

module.exports = router;
