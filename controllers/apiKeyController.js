const apiKeyService = require('../services/apiKeyService');

module.exports.revokeApiKey = async function revokeApiKey(req, res) {
  try {
    const { apiKeyId } = req.body;
    await apiKeyService.revokeApiKey(apiKeyId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error revocando API key:', error);
    res.status(500).json({ success: false, errors: [error.message] });
  }
};