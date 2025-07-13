globalThis.WebSocket = require("websocket").w3cwebsocket;
const express = require('express');
const { router: kascoinjoin1Router } = require('./kascoinjoin');
const { router: kascoinjoin100Router } = require('./kascoinjoin100');
const { router: kascoinjoin1000Router } = require('./kascoinjoin1000');
const { router: kascoinjoin10000Router } = require('./kascoinjoin10000');

const app = express();
const path = require('path');
app.use(express.static(__dirname)); // Serve static files from Backend/

app.use(express.json());

// Mount different pool routers
app.use('/kascoinjoin/1kas', kascoinjoin1Router);      // 1 KAS pool
app.use('/kascoinjoin/100kas', kascoinjoin100Router);  // 100 KAS pool  
app.use('/kascoinjoin/1000kas', kascoinjoin1000Router); // 1000 KAS pool
app.use('/kascoinjoin/10000kas', kascoinjoin10000Router); // 10000 KAS pool

// Legacy route for backward compatibility (defaults to 1 KAS)
app.use('/kascoinjoin', kascoinjoin1Router);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Kascoinjoin backend listening on port ${PORT}`);
  console.log(`Available pools:`);
  console.log(`  - 1 KAS:   /kascoinjoin/1kas`);
  console.log(`  - 100 KAS: /kascoinjoin/100kas`);
  console.log(`  - 1000 KAS: /kascoinjoin/1000kas`);
  console.log(`  - Legacy:  /kascoinjoin (defaults to 1 KAS)`);
}); 