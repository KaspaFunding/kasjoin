# Kaspa Coinjoin Mixer Backend

A privacy-focused coinjoin mixer for Kaspa cryptocurrency that supports multiple pool sizes and KNS domain resolution.

## Features

- **Multiple Pool Sizes**: 1 KAS, 100 KAS, 1000 KAS, and 10000 KAS pools
- **Privacy Enhancement**: Coinjoin mixing to break transaction links
- **KNS Integration**: Support for Kaspa Name Service domains as destination addresses
- **Low Minimum Participants**: Only 5 participants required per pool
- **Real-time Status**: Live session monitoring and status updates
- **Web Interface**: User-friendly frontend for easy interaction

## Prerequisites

- **Node.js** (v16 or higher)
- **npm** (comes with Node.js)
- **Kaspa Node** (for RPC connection)
- **Kaspa WASM SDK** (included in the `kaspa/` directory)

## Installation

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd Kascoinjoin
   ```

2. **Install dependencies**:
   ```bash
   cd Backend
   npm install
   ```

3. **Set up environment variables**:
   Create a `.env` file in the `Backend` directory with the following variables:

   ```env
   see sample.env
   
   # Server Configuration
   PORT=4000
   ```

## Configuration

### Wallet Setup

Each pool requires its own dedicated wallet for security and isolation:

1. **Create separate wallets** for each pool size
2. **Generate private keys** for each wallet
3. **Get wallet addresses** for receiving funds
4. **Fund each wallet** with sufficient KAS for the respective pool size

### Kaspa Node Connection

Ensure your Kaspa node is running and accessible:

- **Default RPC URL**: `ws://localhost:17110`
- **Network**: Set to `mainnet` for production or `testnet` for testing
- **Enable UTXO Index**: Required for the mixer to function properly

## Running the Backend

### Development Mode

1. **Navigate to the Backend directory**:
   ```bash
   cd Backend
   ```

2. **Start the server**:
   ```bash
   npm start
   ```

   Or run directly with Node.js:
   ```bash
   node server.js
   ```

3. **Access the web interface**:
   Open your browser and go to `http://localhost:4000`

### Production Mode

For production deployment:

1. **Set up a process manager** (like PM2):
   ```bash
   npm install -g pm2
   pm2 start server.js --name kascoinjoin
   ```

2. **Set up reverse proxy** (nginx recommended):
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;
       
       location / {
           proxy_pass http://localhost:4000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

## API Endpoints

### Session Management

- `POST /api/session` - Create a new mixing session
- `GET /api/session/:sessionId` - Get session status
- `GET /api/sessions` - List all active sessions

### Pool Information

- `GET /api/pools` - Get available pool information
- `GET /api/pool/:poolSize/status` - Get specific pool status

### KNS Resolution

- `POST /api/resolve-kns` - Resolve KNS domain to Kaspa address

## Usage

### Web Interface

1. **Select a pool size** (1, 100, 1000, or 10000 KAS)
2. **Enter destination address** (Kaspa address or KNS domain)
3. **Create session** and wait for other participants
4. **Monitor status** until the batch is processed
5. **Receive mixed funds** at your destination address

### Programmatic Usage

```javascript
// Create a session
const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        poolSize: 100,
        destinationAddress: 'kaspa:your-address-here'
    })
});

// Check session status
const session = await fetch(`/api/session/${sessionId}`);
```

## Pool Configuration

### Pool Sizes and Requirements

| Pool Size | Minimum Participants | Fee | Batch Time |
|-----------|---------------------|-----|------------|
| 1 KAS     | 5                   | 0.001 KAS | ~10 minutes |
| 100 KAS   | 5                   | 0.01 KAS  | ~10 minutes |
| 1000 KAS  | 5                   | 0.1 KAS   | ~10 minutes |
| 10000 KAS | 5                   | 1 KAS     | ~10 minutes |

### Batch Processing

- Batches are processed when minimum participant count is reached
- Processing time is approximately 10 minutes
- All participants receive their mixed funds simultaneously
- Fees are deducted from each participant's contribution

## Security Considerations

### Wallet Security

- **Use separate wallets** for each pool to prevent cross-contamination
- **Secure private keys** - never expose them in logs or error messages
- **Regular key rotation** for enhanced security
- **Monitor wallet balances** to ensure sufficient funds

### Network Security

- **Use HTTPS** in production environments
- **Implement rate limiting** to prevent abuse
- **Monitor for suspicious activity** and large transaction volumes
- **Regular security audits** of the codebase

### Privacy Features

- **No transaction linking** - mixed outputs cannot be traced back to inputs
- **Random delays** in batch processing to prevent timing analysis
- **No user data storage** - sessions are ephemeral
- **KNS domain support** for additional privacy layer

## Troubleshooting

### Common Issues

1. **Connection Errors**:
   - Verify Kaspa node is running
   - Check RPC URL and network settings
   - Ensure UTXO index is enabled

2. **Wallet Errors**:
   - Verify wallet secrets and private keys
   - Check wallet balances
   - Ensure addresses are valid for the network

3. **Session Issues**:
   - Check minimum participant requirements
   - Verify destination address format
   - Monitor for batch processing delays

### Logs and Debugging

Enable debug logging by setting the log level:

```javascript
// In server.js
setLogLevel('debug');
```

Check the console output for detailed error messages and transaction status.

## Development

### Project Structure

```
Kascoinjoin/
├── Backend/
│   ├── server.js              # Main server file
│   ├── kascoinjoin.js         # Core mixing logic
│   ├── admin-middleware.js    # Admin authentication
│   ├── db.js                  # Database operations
│   ├── package.json           # Dependencies
│   └── index.html             # Web interface
├── kaspa/                     # Kaspa WASM SDK
│   ├── kaspa.js
│   ├── kaspa.d.ts
│   └── kaspa_bg.wasm
└── README.md
```

### Adding New Features

1. **Backend Logic**: Modify `kascoinjoin.js` for core functionality
2. **API Endpoints**: Add routes in `server.js`
3. **Frontend**: Update `index.html` for UI changes
4. **Configuration**: Add environment variables as needed

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

[Add your license information here]

## Support

For issues and questions:
- Create an issue on GitHub
- Check the troubleshooting section
- Review the Kaspa documentation for RPC details

## Disclaimer

This software is provided as-is for educational and research purposes. Users are responsible for their own security and should thoroughly test the system before using it with real funds. 
