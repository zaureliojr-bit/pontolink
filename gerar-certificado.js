// Gera um certificado HTTPS local (autoassinado) para o celular poder usar a câmera.
// Uso: node gerar-certificado.js   (rode de novo se o IP do computador mudar)
const selfsigned = require('selfsigned');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ips = Object.values(os.networkInterfaces()).flat()
  .filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7, ip }))];

Promise.resolve(selfsigned.generate([{ name: 'commonName', value: 'PontoLink' }], {
  days: 825, keySize: 2048, algorithm: 'sha256',
  extensions: [{ name: 'subjectAltName', altNames }],
})).then((pems) => {
  const dir = path.join(__dirname, 'data', 'cert');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'key.pem'), pems.private);
  fs.writeFileSync(path.join(dir, 'cert.pem'), pems.cert);
  console.log('Certificado criado para: localhost, ' + (ips.join(', ') || '(nenhum IP de rede encontrado)'));
  console.log('Reinicie o servidor e abra no celular o endereço https:// que ele mostrar.');
});
