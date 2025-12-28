const http = require('http');
const net = require('net');
const PORT = process.env.PORT || 65405;
// ====== ฟังก์ชัน pingServer แบบ TCP raw ======
async function pingServer(hostPort) {
    return new Promise((resolve) => {
        const [host, portStr] = hostPort.split(':');
        const port = parseInt(portStr || 25565); // default Minecraft port
        const socket = new net.Socket();
        let startTime = Date.now();

        socket.setTimeout(3000); // timeout 3 วินาที

        socket.connect(port, host, () => {
            // สร้าง Handshake + Status Request (Java 1.21.x)
            const handshake = Buffer.from([
                0x0f, // packet length (fake, server tolerates)
                0x00, // packet id handshake
                0x2f, // protocol version (fake, 47 = 1.8, server tolerates)
                ...Buffer.from(host, 'utf8'),
                (port >> 8) & 0xff,
                port & 0xff,
                0x01 // next state = status
            ]);
            const request = Buffer.from([0x01, 0x00]); // packet length 1, id 0x00 status request
            socket.write(handshake);
            socket.write(request);
        });

        let dataBuffer = Buffer.alloc(0);

        socket.on('data', data => {
            dataBuffer = Buffer.concat([dataBuffer, data]);
        });

        socket.on('end', () => {
            const latency = Date.now() - startTime;
            resolve({ latency, raw: dataBuffer.toString() });
        });

        socket.on('timeout', () => {
            socket.destroy();
            resolve({ error: 'timeout' });
        });

        socket.on('error', (err) => {
            resolve({ error: err.message });
        });
    });
}

// ====== สร้าง HTTP Server รับ POST request เช็ค ping ======
const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/ping') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { host } = data;
                if (!host) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Missing host field' }));
                }

                const result = await pingServer(host);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ host, result }));

            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.toString() }));
            }
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(PORT, () => console.log(`[HTTP] Ping API server running on port ${PORT}`));

