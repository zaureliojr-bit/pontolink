const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (IS_PRODUCTION && (!process.env.ADMIN_PIN || !/^\d{8,}$/.test(process.env.ADMIN_PIN))) {
  console.error('ERRO: configure ADMIN_PIN no Railway com pelo menos 8 dígitos antes de iniciar.');
  process.exit(1);
}
const ADMIN_PIN = process.env.ADMIN_PIN || '0000'; // apenas para desenvolvimento local
const TZ = 'America/Sao_Paulo';
const JORNADA_MIN = 8 * 60;
const FACE_THRESHOLD = Number(process.env.FACE_THRESHOLD || 0.5); // menor = mais rígido
const faceDistance = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));
const applyTol = (bal, tol) => (Math.abs(bal) <= tol ? 0 : bal); // tolerância diária (CLT: até 10 min)
const validDescriptor = (d) => Array.isArray(d) && d.length === 128 && d.every(Number.isFinite);
const REQUIRE_DEVICE = IS_PRODUCTION || process.env.REQUIRE_DEVICE !== 'false'; // em produção é sempre exigido
const SEQ = ['entrada', 'saida_almoco', 'volta_almoco', 'saida'];

// No Railway, configure DATA_DIR com o caminho do Volume (ex.: /data).
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PHOTOS = path.join(DATA, 'photos');
fs.mkdirSync(PHOTOS, { recursive: true });

const db = new Database(path.join(DATA, 'ponto.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS punches (
  id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id),
  type TEXT NOT NULL, ts TEXT NOT NULL, day TEXT NOT NULL,
  photo TEXT, note TEXT, manual INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_punches_day ON punches(day, employee_id);
`);

try { db.exec('ALTER TABLE employees ADD COLUMN face TEXT'); } catch {} // já existe
try { db.exec('ALTER TABLE employees ADD COLUMN jornada_min INTEGER NOT NULL DEFAULT 480'); } catch {}
try { db.exec('ALTER TABLE employees ADD COLUMN tolerance_min INTEGER NOT NULL DEFAULT 10'); } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  created_ts TEXT NOT NULL, last_seen TEXT, active INTEGER NOT NULL DEFAULT 1)`);

const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
const dayOf = (d) => d.toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
const todayPunches = (empId, day) =>
  db.prepare('SELECT * FROM punches WHERE employee_id=? AND day=? ORDER BY ts').all(empId, day);
const nextType = (list) => SEQ[list.length] || null;

// bloqueio simples contra tentativas de PIN
const fails = new Map();
const locked = (id) => (fails.get(id) || { n: 0, until: 0 }).until > Date.now();
const fail = (id) => {
  const f = fails.get(id) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) { f.until = Date.now() + 5 * 60 * 1000; f.n = 0; }
  fails.set(id, f);
};

const app = express();
app.disable('x-powered-by');
if (IS_PRODUCTION) app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.get('/health', (req, res) => res.status(200).json({ ok: true, app: 'PontoLink' }));
app.use(express.static(path.join(__dirname, 'public')));
const FACE_PKG = path.join(__dirname, 'node_modules', '@vladmandic', 'face-api');
app.use('/vendor', express.static(path.join(FACE_PKG, 'dist')));
app.use('/models', express.static(path.join(FACE_PKG, 'model')));

// ---------- Tablet / balcão ----------
// Só aparelhos autorizados pelo gestor (celular da loja) listam funcionários e registram ponto.
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const device = (req, res, next) => {
  if (!REQUIRE_DEVICE) return next();
  const token = req.get('x-device-token');
  const d = token && db.prepare('SELECT id FROM devices WHERE token_hash=? AND active=1').get(sha256(token));
  if (!d) return res.status(403).json({ error: 'Este aparelho não está autorizado. Peça ao gestor para autorizar.', code: 'device_unpaired' });
  db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(new Date().toISOString(), d.id);
  next();
};

app.get('/api/employees', device, (req, res) => {
  const day = dayOf(new Date());
  const rows = db.prepare('SELECT id, name, face IS NOT NULL AS has_face FROM employees WHERE active=1 ORDER BY name').all();
  res.json(rows.map((e) => ({ ...e, has_face: !!e.has_face, next: nextType(todayPunches(e.id, day)) })));
});

app.post('/api/punch', device, (req, res) => {
  const { employee_id, pin, photo, descriptor } = req.body || {};
  const emp = db.prepare('SELECT * FROM employees WHERE id=? AND active=1').get(employee_id);
  if (!emp) return res.status(404).json({ error: 'Funcionário não encontrado.' });
  if (locked(emp.id)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 5 minutos.' });
  if (hashPin(pin, emp.salt) !== emp.pin_hash) {
    fail(emp.id);
    return res.status(401).json({ error: 'PIN incorreto.' });
  }
  if (!emp.face) return res.status(403).json({ error: 'Rosto não cadastrado. Peça ao gestor para cadastrar.' });
  if (emp.face) {
    if (!validDescriptor(descriptor)) return res.status(400).json({ error: 'Rosto não detectado. Olhe para a câmera e tente de novo.' });
    if (faceDistance(JSON.parse(emp.face), descriptor) > FACE_THRESHOLD) {
      fail(emp.id);
      return res.status(401).json({ error: 'Rosto não reconhecido.' });
    }
  }
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(photo || '');
  if (!m) return res.status(400).json({ error: 'Foto obrigatória para registrar o ponto.' });

  const now = new Date();
  const day = dayOf(now);
  const type = nextType(todayPunches(emp.id, day));
  if (!type) return res.status(409).json({ error: 'Os 4 registros de hoje já foram feitos.' });

  const file = `${now.getTime()}-${emp.id}.jpg`;
  fs.writeFileSync(path.join(PHOTOS, file), Buffer.from(m[1], 'base64'));
  db.prepare('INSERT INTO punches (employee_id,type,ts,day,photo) VALUES (?,?,?,?,?)')
    .run(emp.id, type, now.toISOString(), day, file);
  res.json({ ok: true, name: emp.name, type, ts: now.toISOString() });
});

// ---------- Gestor ----------
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
db.exec('CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, action TEXT NOT NULL, employee_id INTEGER, detail TEXT NOT NULL)');
const audit = (action, employeeId, detail) =>
  db.prepare('INSERT INTO audit_log (ts,action,employee_id,detail) VALUES (?,?,?,?)').run(new Date().toISOString(), action, employeeId ?? null, detail);
const empName = (id) => db.prepare('SELECT name FROM employees WHERE id=?').get(id)?.name || `#${id}`;
const TYPE_LABEL = { entrada: 'entrada', saida_almoco: 'saída para almoço', volta_almoco: 'volta do almoço', saida: 'saída' };
const fmtLocal = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });
const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
const setAdminPin = (pin) => {
  const salt = crypto.randomBytes(16).toString('hex');
  setSetting('admin_salt', salt);
  setSetting('admin_hash', hashPin(pin, salt));
};
if (!getSetting('admin_hash')) { setAdminPin(ADMIN_PIN); setSetting('admin_default', process.env.ADMIN_PIN ? '0' : '1'); }
const adminOk = (pin) => {
  if (typeof pin !== 'string' || !pin) return false;
  const a = Buffer.from(hashPin(pin, getSetting('admin_salt')), 'hex');
  return crypto.timingSafeEqual(a, Buffer.from(getSetting('admin_hash'), 'hex'));
};
const admin = (req, res, next) => {
  const key = `admin:${req.ip}`; // bloqueio por IP: quem erra o PIN não trava o gestor em outro lugar
  if (locked(key)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 5 minutos.' });
  if (adminOk(req.get('x-admin-pin'))) { fails.delete(key); return next(); }
  fail(key);
  res.status(401).json({ error: 'PIN do gestor inválido.' });
};

app.get('/api/admin/status', admin, (req, res) => res.json({ default_pin: getSetting('admin_default') === '1' }));

app.post('/api/admin/pin', admin, (req, res) => {
  const { new_pin } = req.body || {};
  if (!/^\d{8,12}$/.test(new_pin || '')) return res.status(400).json({ error: 'Use de 8 a 12 dígitos.' });
  setAdminPin(new_pin);
  setSetting('admin_default', '0');
  audit('pin_gestor_alterado', null, 'Trocou o PIN do gestor');
  res.json({ ok: true });
});

// ---- aparelhos autorizados (celular da loja) ----
app.post('/api/pair', admin, (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Dê um nome ao aparelho (ex.: Celular do balcão).' });
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO devices (name, token_hash, created_ts) VALUES (?,?,?)').run(name, sha256(token), new Date().toISOString());
  audit('aparelho_autorizado', null, `Autorizou o aparelho "${name}"`);
  res.json({ token });
});

app.get('/api/admin/devices', admin, (req, res) =>
  res.json(db.prepare('SELECT id, name, created_ts, last_seen FROM devices WHERE active=1 ORDER BY id').all()));

app.delete('/api/admin/devices/:id', admin, (req, res) => {
  const d = db.prepare('SELECT name FROM devices WHERE id=? AND active=1').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Aparelho não encontrado.' });
  db.prepare('UPDATE devices SET active=0 WHERE id=?').run(req.params.id);
  audit('aparelho_revogado', null, `Revogou o aparelho "${d.name}"`);
  res.json({ ok: true });
});

// ---- backup: baixar cópias para guardar fora do Railway ----
app.get('/api/admin/backup/db', admin, async (req, res) => {
  const tmp = path.join(os.tmpdir(), `pontolink-${Date.now()}.db`);
  try {
    await db.backup(tmp);
    res.download(tmp, `pontolink-banco-${dayOf(new Date())}.db`, () => fs.unlink(tmp, () => {}));
  } catch { res.status(500).json({ error: 'Falha ao gerar o backup do banco.' }); }
});

app.get('/api/admin/backup/photos', admin, (req, res) => {
  res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="pontolink-fotos-${dayOf(new Date())}.tar.gz"` });
  const tar = require('child_process').spawn('tar', ['-czf', '-', '-C', DATA, 'photos']);
  tar.stdout.pipe(res);
  tar.on('error', () => res.end());
});

app.get('/api/admin/audit', admin, (req, res) =>
  res.json(db.prepare('SELECT ts, action, detail FROM audit_log ORDER BY id DESC LIMIT 100').all()));

app.get('/api/admin/employees', admin, (req, res) =>
  res.json(db.prepare('SELECT id, name, active, jornada_min, tolerance_min, face IS NOT NULL AS has_face FROM employees ORDER BY name').all()));

app.post('/api/admin/employees', admin, (req, res) => {
  const { name, pin, jornada_min } = req.body || {};
  if (!name || !/^\d{4,6}$/.test(pin || '')) return res.status(400).json({ error: 'Informe nome e PIN de 4 a 6 dígitos.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const jor = Number.isInteger(jornada_min) && jornada_min >= 60 && jornada_min <= 720 ? jornada_min : JORNADA_MIN;
  const r = db.prepare('INSERT INTO employees (name,salt,pin_hash,jornada_min) VALUES (?,?,?,?)').run(name.trim(), salt, hashPin(pin, salt), jor);
  audit('funcionario_criado', Number(r.lastInsertRowid), `Cadastrou ${name.trim()} (jornada de ${jor / 60}h)`);
  res.json({ ok: true });
});

app.post('/api/admin/employees/:id/face', admin, (req, res) => {
  if (!validDescriptor(req.body.descriptor)) return res.status(400).json({ error: 'Descritor facial inválido.' });
  db.prepare('UPDATE employees SET face=? WHERE id=?').run(JSON.stringify(req.body.descriptor), req.params.id);
  audit('rosto_cadastrado', Number(req.params.id), `Cadastrou o rosto de ${empName(req.params.id)}`);
  res.json({ ok: true });
});

app.delete('/api/admin/employees/:id/face', admin, (req, res) => {
  db.prepare('UPDATE employees SET face=NULL WHERE id=?').run(req.params.id);
  audit('rosto_removido', Number(req.params.id), `Removeu o rosto de ${empName(req.params.id)}`);
  res.json({ ok: true });
});

app.patch('/api/admin/employees/:id', admin, (req, res) => {
  const { active, jornada_min, tolerance_min, name, pin } = req.body || {};
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'Informe o nome.' });
    const antes = empName(req.params.id);
    db.prepare('UPDATE employees SET name=? WHERE id=?').run(String(name).trim(), req.params.id);
    audit('funcionario_renomeado', Number(req.params.id), `Renomeou ${antes} para ${String(name).trim()}`);
  }
  if (pin !== undefined) {
    if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: 'O PIN deve ter de 4 a 6 dígitos.' });
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE employees SET salt=?, pin_hash=? WHERE id=?').run(salt, hashPin(pin, salt), req.params.id);
    fails.delete(Number(req.params.id)); // libera bloqueio por tentativas
    audit('pin_redefinido', Number(req.params.id), `Redefiniu o PIN de ${empName(req.params.id)}`);
  }
  if (active !== undefined) {
    db.prepare('UPDATE employees SET active=? WHERE id=?').run(active ? 1 : 0, req.params.id);
    audit('funcionario_status', Number(req.params.id), `${active ? 'Ativou' : 'Desativou'} ${empName(req.params.id)}`);
  }
  if (jornada_min !== undefined || tolerance_min !== undefined) {
    if (!Number.isInteger(jornada_min) || jornada_min < 60 || jornada_min > 720 || !Number.isInteger(tolerance_min) || tolerance_min < 0 || tolerance_min > 30)
      return res.status(400).json({ error: 'Jornada entre 1h e 12h e tolerância entre 0 e 30 minutos.' });
    db.prepare('UPDATE employees SET jornada_min=?, tolerance_min=? WHERE id=?').run(jornada_min, tolerance_min, req.params.id);
    audit('jornada_alterada', Number(req.params.id), `Alterou a jornada de ${empName(req.params.id)} para ${jornada_min / 60}h, tolerância de ${tolerance_min} min`);
  }
  res.json({ ok: true });
});

// marcação manual (esquecimento etc.) — justificativa obrigatória; horário de Brasília (-03:00)
app.post('/api/admin/punches', admin, (req, res) => {
  const { employee_id, type, datetime, note } = req.body || {};
  if (!SEQ.includes(type) || !datetime || !note) return res.status(400).json({ error: 'Informe tipo, data/hora e justificativa.' });
  const d = new Date(`${datetime}:00-03:00`);
  if (isNaN(d)) return res.status(400).json({ error: 'Data/hora inválida.' });
  db.prepare('INSERT INTO punches (employee_id,type,ts,day,note,manual) VALUES (?,?,?,?,?,1)')
    .run(employee_id, type, d.toISOString(), dayOf(d), note);
  audit('marcacao_manual', Number(employee_id), `Adicionou ${TYPE_LABEL[type]} de ${empName(employee_id)} em ${fmtLocal(d.toISOString())} — justificativa: ${note}`);
  res.json({ ok: true });
});

app.delete('/api/admin/punches/:id', admin, (req, res) => {
  const p = db.prepare('SELECT * FROM punches WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Marcação não encontrada.' });
  db.prepare('DELETE FROM punches WHERE id=?').run(req.params.id);
  audit('marcacao_excluida', p.employee_id, `Excluiu ${TYPE_LABEL[p.type]} de ${empName(p.employee_id)} de ${fmtLocal(p.ts)}${p.manual ? ' (era manual)' : ''}`);
  res.json({ ok: true });
});

app.get('/api/admin/photo/:id', admin, (req, res) => {
  const p = db.prepare('SELECT photo FROM punches WHERE id=?').get(req.params.id);
  if (!p || !p.photo) return res.status(404).end();
  res.sendFile(path.join(PHOTOS, path.basename(p.photo)));
});

app.get('/api/admin/report', admin, (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : dayOf(new Date()).slice(0, 7);
  const emp = Number(req.query.employee) || null;
  const rows = db.prepare(
    `SELECT p.id, p.employee_id, e.name, e.jornada_min, e.tolerance_min, p.type, p.ts, p.day, p.note, p.manual, p.photo IS NOT NULL AS has_photo
     FROM punches p JOIN employees e ON e.id=p.employee_id WHERE p.day LIKE ? AND (? IS NULL OR p.employee_id = ?) ORDER BY p.day, p.ts`
  ).all(`${month}-%`, emp, emp);

  const groups = {};
  for (const r of rows) (groups[`${r.employee_id}|${r.day}`] ||= []).push(r);

  const days = Object.values(groups).map((list) => {
    let start = null, worked = 0;
    for (const p of list) {
      if (p.type === 'entrada' || p.type === 'volta_almoco') start = new Date(p.ts);
      else if (start) { worked += (new Date(p.ts) - start) / 60000; start = null; }
    }
    const complete = list.some((p) => p.type === 'saida');
    return {
      employee_id: list[0].employee_id, name: list[0].name, day: list[0].day, punches: list,
      worked_min: Math.round(worked), complete,
      jornada_min: list[0].jornada_min,
      balance_min: complete ? applyTol(Math.round(worked) - list[0].jornada_min, list[0].tolerance_min) : null,
    };
  });
  // totais do mês: só dias completos (com saída) entram em trabalhado/previsto/saldo
  const sum = {};
  for (const d of days) {
    const s = (sum[d.employee_id] ||= { employee_id: d.employee_id, name: d.name, days_worked: 0, open_days: 0, worked_min: 0, expected_min: 0, balance_min: 0 });
    if (d.complete) { s.days_worked++; s.worked_min += d.worked_min; s.expected_min += d.jornada_min; s.balance_min += d.balance_min; }
    else s.open_days++;
  }
  res.json({ month, days, summary: Object.values(sum).sort((a, b) => a.name.localeCompare(b.name)) });
});

// HTTPS opcional: com data/cert/key.pem e cert.pem (gerados por `node gerar-certificado.js`) o celular libera a câmera
const certDir = path.join(DATA, 'cert');
// Em produção, o Railway termina HTTPS na borda; certificado autoassinado é só para LAN local.
const useHttps = !IS_PRODUCTION && fs.existsSync(path.join(certDir, 'key.pem')) && fs.existsSync(path.join(certDir, 'cert.pem'));
const server = useHttps
  ? require('https').createServer({ key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) }, app)
  : require('http').createServer(app);

server.listen(PORT, '0.0.0.0', () => {
  const proto = useHttps ? 'https' : 'http';
  console.log(`PontoLink rodando em ${proto}://localhost:${PORT}`);
  Object.values(os.networkInterfaces()).flat()
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .forEach((i) => console.log(`No celular (mesmo Wi-Fi): ${proto}://${i.address}:${PORT}`));
  if (!useHttps) console.log('Atenção: sem HTTPS o celular não libera a câmera. Rode: node gerar-certificado.js');
});
