const { randomUUID } = require('crypto');
const problemChatService = require('../services/problemChatService');

/**
 * Open a problem-chat session. Body: { runnerConfiguration: { modelName, apiKeyId, apiKeyRequesterId } }
 * POST /api/v1/problems/chat/session
 */
const openProblemChat = async (req, res) => {
  try {
    const runnerConfiguration = req.body.runnerConfiguration || {};
    const chatId = randomUUID();
    const result = await problemChatService.openSession(chatId, runnerConfiguration);
    res.status(201).json(result);
  } catch (error) {
    console.error('Error opening problem chat:', error);
    res.status(error.statusCode || 500).json({ error: 'Failed to open problem chat', message: error.message });
  }
};

/**
 * Attach a PDF to a problem-chat session (multipart field "file").
 * POST /api/v1/problems/chat/:chatId/files
 */
const uploadProblemChatFile = async (req, res) => {
  try {
    const { chatId } = req.params;
    if (!req.file) {
      return res.status(400).json({ error: 'A PDF file is required (multipart field "file")' });
    }
    const result = await problemChatService.uploadFile(chatId, req.file.buffer, req.file.originalname);
    res.status(201).json(result);
  } catch (error) {
    console.error('Error uploading problem-chat file:', error);
    res.status(error.statusCode || 500).json({ error: 'Failed to upload file', message: error.message });
  }
};

/**
 * Send a chat message. Body: { message, tools?, toolResults? }.
 * Returns { toolCalls } when the model invokes a frontend tool, else { message }.
 * POST /api/v1/problems/chat/:chatId/messages
 */
const sendProblemChatMessage = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { message, tools, toolResults, fileIds } = req.body;
    const hasToolResults = Array.isArray(toolResults) && toolResults.length > 0;
    if ((typeof message !== 'string' || message.length === 0) && !hasToolResults) {
      return res.status(400).json({ error: 'A message or toolResults are required' });
    }
    const result = await problemChatService.sendMessage(chatId, { message, tools, toolResults, fileIds });
    res.status(200).json(result);
  } catch (error) {
    console.error('Error in problem-chat message:', error);
    res.status(error.statusCode || 500).json({ error: 'Failed to process message', message: error.message });
  }
};

module.exports = { openProblemChat, uploadProblemChatFile, sendProblemChatMessage };
