import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });


wss.on('connection', (ws) => {
  console.log('Новый клиент подключился!');

  ws.on('message', (message) => {
    console.log(`Получено сообщение: ${message}`);
    ws.send('Сообщение получено!');
  });

  ws.on('close', () => {
    console.log('Клиент отключился');
  });
});