const { redisClient } = require('../config/redis');
const modelManager = require('../models/modelManager');

/**
 * Realiza pruebas automáticas en todos los modelos disponibles
 */
async function testAllModels() {
  console.log('Iniciando tests de modelos...');

  try {
    // Conectar a Redis si aún no está conectado
    if (!redisClient.isOpen) {
      await redisClient.connect();
    }

    // Inicializar el gestor de modelos
    await modelManager.initialize();
    
    // Mostrar modelos disponibles
    const availableModels = modelManager.getAvailableModels();
    console.log('Modelos disponibles después de los tests:', availableModels);
    
    // Cerrar la conexión a Redis
    await redisClient.quit();
    
    console.log('Tests de modelos completados');
    return { success: true, models: availableModels };
  } catch (error) {
    console.error('Error en los tests de modelos:', error);
    
    // Cerrar la conexión a Redis
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
    
    return { success: false, error: error.message };
  }
}

// Ejecutar los tests si este archivo se ejecuta directamente
if (require.main === module) {
  testAllModels()
    .then((result) => {
      console.log('Resultado de los tests:', result);
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Error ejecutando los tests:', error);
      process.exit(1);
    });
}

module.exports = { testAllModels }; 