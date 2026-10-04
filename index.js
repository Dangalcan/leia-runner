var http = require('http');
var express = require("express");
var swaggerUi = require('swagger-ui-express');
var path = require('path');
require('dotenv').config();
const { initRedis } = require('./config/redis');
const modelManager = require('./models/modelManager');
const leiasRoutes = require('./routes/leiasRoutes');
const apiKeyRoutes = require('./routes/apiKeyRoutes');

const deploy = async () => {
    const serverPort = process.env.PORT || 5000;
    const app = express();
    app.use(express.json({ limit: '50mb' }));

    try {
        await initRedis();
        
        await modelManager.initialize();

        app.use('/openapi', express.static(path.join(__dirname, 'api')));
        app.use('/docs', swaggerUi.serve, swaggerUi.setup(null, {
            customCss: '.swagger-ui .topbar { display: none }',
            swaggerUrl: '/openapi/openapi.yml',
            swaggerOptions: {
                persistAuthorization: true
            }
        }));

        app.use('/api/v1', leiasRoutes);
        app.use('/api/v1', apiKeyRoutes);

        http.createServer(app).listen(serverPort, () => {
            console.log("\nApp running at http://localhost:" + serverPort);
            console.log("________________________________________________________________");
            console.log("API docs (Swagger UI) available on http://localhost:" + serverPort + "/docs");
            console.log("________________________________________________________________");
        });
    } catch (error) {
        console.error('Error starting the application:', error);
        process.exit(1);
    }
}

const undeploy = () => {
    process.exit();
};

module.exports = {
    deploy: deploy,
    undeploy: undeploy
}

