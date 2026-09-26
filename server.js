const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 5000;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) console.warn('DATABASE_URL is not set. Set it in Render Environment Variables.');

const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
}) : null;

let currentRound = { roundId: Date.now(), timeLeft: 30, status: 'OPEN' };
let currentBets = [];
let winningColor = 'GREEN';
let winningNumber = 5;

async function db(query, params=[]) {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  return pool.query(query, params);
}

async function initDb() {
  if (!pool) return;
  await db(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    mobile TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    balance NUMERIC(12,2) NOT NULL DEFAULT 1000,
    is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db(`CREATE TABLE IF NOT EXISTS deposits (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount NUMERIC(12,2) NOT NULL,
    utr_number TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db(`CREATE TABLE IF NOT EXISTS withdrawals (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount NUMERIC(12,2) NOT NULL,
    upi_id TEXT,
    account_details TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const exists = await db('SELECT id FROM users WHERE mobile=$1', ['9876543210']);
  if (!exists.rowCount) {
    const hash = await bcrypt.hash('123', 10);
    await db('INSERT INTO users(name,mobile,password_hash,balance) VALUES($1,$2,$3,$4)', ['Player 1','9876543210',hash,1000]);
  }
}

function publicUser(u) {
  return { name: u.name, mobile: u.mobile, balance: Number(u.balance), isBlocked: !!u.is_blocked };
}

function adminAuth(req, res, next) {
  const key = process.env.ADMIN_KEY;
  if (!key) return res.status(500).json({success:false,message:'ADMIN_KEY is not configured on server.'});
  if (req.headers['x-admin-key'] !== key) return res.status(401).json({success:false,message:'Unauthorized'});
  next();
}

async function getUser(mobile) {
  const r = await db('SELECT * FROM users WHERE mobile=$1', [mobile]);
  return r.rows[0];
}

async function sendTelegramMessage(text, replyMarkup=null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('Telegram notification skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured.');
    return false;
  }
  try {
    const body = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      console.error('Telegram API error:', await response.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('Telegram notification error:', e.message);
    return false;
  }
}


function telegramAdminId() {
  return String(process.env.TELEGRAM_ADMIN_ID || '6930997805').trim();
}

async function telegramApi(method, payload={}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!data.ok) console.error('Telegram API error:', data.description || data);
    return data;
  } catch (e) {
    console.error('Telegram API request error:', e.message);
    return null;
  }
}

async function editTelegramDepositMessage(chatId, messageId, text) {
  return telegramApi('editMessageText', {chat_id: chatId, message_id: messageId, text, parse_mode:'HTML'});
}

let telegramOffset = 0;
let telegramPolling = false;
async function handleTelegramUpdate(update) {
  const callback = update.callback_query;
  if (!callback) return;
  const fromId = String(callback.from && callback.from.id || '');
  const adminId = telegramAdminId();
  if (fromId !== adminId) {
    await telegramApi('answerCallbackQuery', {callback_query_id: callback.id, text:'Unauthorized admin.', show_alert:true});
    return;
  }
  const data = String(callback.data || '');
  const match = data.match(/^deposit:(approve|reject):(\d+)$/);
  if (!match) {
    await telegramApi('answerCallbackQuery', {callback_query_id: callback.id, text:'Unknown action.', show_alert:true});
    return;
  }
  const action = match[1];
  const depositId = Number(match[2]);
  try {
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      const d = await client.query('SELECT d.*,u.name,u.mobile FROM deposits d JOIN users u ON u.id=d.user_id WHERE d.id=$1 FOR UPDATE',[depositId]);
      if (!d.rowCount) { await client.query('ROLLBACK'); await telegramApi('answerCallbackQuery',{callback_query_id:callback.id,text:'Deposit not found.',show_alert:true}); return; }
      const dep = d.rows[0];
      if (dep.status !== 'PENDING') { await client.query('ROLLBACK'); await telegramApi('answerCallbackQuery',{callback_query_id:callback.id,text:`Already ${dep.status}.`,show_alert:true}); return; }
      if (action === 'approve') {
        await client.query("UPDATE deposits SET status='APPROVED' WHERE id=$1",[depositId]);
        await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2',[dep.amount,dep.user_id]);
        result = {status:'APPROVED', amount:Number(dep.amount), name:dep.name, mobile:dep.mobile, utr:dep.utr_number};
      } else {
        await client.query("UPDATE deposits SET status='REJECTED' WHERE id=$1",[depositId]);
        result = {status:'REJECTED', amount:Number(dep.amount), name:dep.name, mobile:dep.mobile, utr:dep.utr_number};
      }
      await client.query('COMMIT');
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { client.release(); }

    const statusText = result.status === 'APPROVED' ? '✅ APPROVED' : '❌ REJECTED';
    const text = `<b>📥 Deposit Request #${depositId}</b>\n\n`+
      `<b>User:</b> ${String(result.name).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}\n`+
      `<b>Mobile:</b> ${result.mobile}\n`+
      `<b>Amount:</b> ₹${result.amount.toFixed(2)}\n`+
      `<b>UTR:</b> ${String(result.utr||'-').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}\n`+
      `<b>Status:</b> ${statusText}`;
    const msg = callback.message;
    if (msg) await editTelegramDepositMessage(msg.chat.id, msg.message_id, text);
    await telegramApi('answerCallbackQuery', {callback_query_id:callback.id, text: result.status === 'APPROVED' ? 'Approved — wallet credited.' : 'Rejected — wallet not credited.'});
  } catch (e) {
    console.error('Telegram deposit action error:', e.message);
    await telegramApi('answerCallbackQuery', {callback_query_id:callback.id, text:'Action failed. Check server/database.',show_alert:true});
  }
}

async function telegramPollLoop() {
  if (telegramPolling || !process.env.TELEGRAM_BOT_TOKEN || !pool) return;
  telegramPolling = true;
  while (true) {
    try {
      const data = await telegramApi('getUpdates', {offset:telegramOffset, timeout:25, allowed_updates:['callback_query']});
      if (data && data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          telegramOffset = Math.max(telegramOffset, update.update_id + 1);
          await handleTelegramUpdate(update);
        }
      }
    } catch (e) { console.error('Telegram polling error:', e.message); }
    await new Promise(r=>setTimeout(r, 500));
  }
}

function calculateAndPayResults() {
  const colors = ['GREEN','RED','VIOLET'];
  winningColor = colors[Math.floor(Math.random() * colors.length)];
  winningNumber = Math.floor(Math.random() * 10);
  // Keep the original round payout behavior, persisted to PostgreSQL.
  Promise.all(currentBets.map(async bet => {
    try {
      const user = await getUser(bet.userId);
      if (!user) return;
      let winAmount = 0;
      if (bet.betType === 'COLOR' && bet.betValue === winningColor) winAmount = bet.amount * 2;
      if (bet.betType === 'NUMBER' && parseInt(bet.betValue) === winningNumber) winAmount = bet.amount * 9;
      if (winAmount) await db('UPDATE users SET balance=balance+$1 WHERE id=$2', [winAmount, user.id]);
    } catch(e) { console.error('Payout error:', e.message); }
  })).catch(()=>{});
}

setInterval(() => {
  currentRound.timeLeft--;
  if (currentRound.timeLeft <= 5 && currentRound.status === 'OPEN') currentRound.status = 'CLOSED';
  if (currentRound.timeLeft <= 0) {
    calculateAndPayResults();
    currentRound = { roundId: Date.now(), timeLeft: 30, status: 'OPEN' };
    currentBets = [];
  }
}, 1000);

app.post('/api/register', async (req,res) => {
  try {
    const {name,mobile,password} = req.body;
    if (!name || !mobile || !password) return res.status(400).json({success:false,message:'Name, mobile and password are required!'});
    if (!/^\d{10}$/.test(String(mobile))) return res.status(400).json({success:false,message:'Enter a valid 10-digit mobile number!'});
    const existing = await getUser(mobile);
    if (existing) return res.status(400).json({success:false,message:'Mobile number already registered!'});
    const hash = await bcrypt.hash(String(password), 10);
    const r = await db('INSERT INTO users(name,mobile,password_hash,balance) VALUES($1,$2,$3,1000) RETURNING *',[name,String(mobile),hash]);
    res.json({success:true,message:'Registration Successful! ₹1000 Bonus added.',user:publicUser(r.rows[0])});
  } catch(e) { console.error(e); res.status(500).json({success:false,message:'Registration failed!'}); }
});

app.post('/api/login', async (req,res) => {
  try {
    const {mobile,password} = req.body;
    const user = await getUser(String(mobile || ''));
    if (!user || !(await bcrypt.compare(String(password || ''), user.password_hash))) return res.status(400).json({success:false,message:'Invalid Mobile or Password!'});
    if (user.is_blocked) return res.status(403).json({success:false,message:'Your account is blocked by admin.'});
    res.json({success:true,message:'Login Successful!',user:publicUser(user)});
  } catch(e) { res.status(500).json({success:false,message:'Login failed!'}); }
});

app.get('/api/game-status',(req,res)=>res.json({roundId:currentRound.roundId,timeLeft:currentRound.timeLeft,status:currentRound.status,lastWinningColor:winningColor,lastWinningNumber:winningNumber}));

app.get('/api/user/:userId', async (req,res)=>{
  try { const user=await getUser(req.params.userId); if(!user) return res.status(404).json({success:false,message:'User not found'}); res.json({success:true,balance:Number(user.balance),userId:user.mobile,name:user.name}); }
  catch(e){res.status(500).json({success:false,message:'Server error'});}
});

app.post('/api/place-bet', async (req,res)=>{
  try {
    const {userId,betType,betValue,amount}=req.body;
    const value=Number(amount);
    if(currentRound.status!=='OPEN') return res.status(400).json({success:false,message:'Betting closed!'});
    if(!Number.isFinite(value)||value<10) return res.status(400).json({success:false,message:'Minimum Bet Amount ₹10 honi chahiye!'});
    const user=await getUser(userId);
    if(!user || user.is_blocked || Number(user.balance)<value) return res.status(400).json({success:false,message:'Insufficient Balance!'});
    const updated=await db('UPDATE users SET balance=balance-$1 WHERE id=$2 AND balance >= $1 RETURNING balance',[value,user.id]);
    if(!updated.rowCount) return res.status(400).json({success:false,message:'Insufficient Balance!'});
    currentBets.push({userId,betType,betValue,amount:value});
    res.json({success:true,message:'Bet Placed Successfully!',remainingBalance:Number(updated.rows[0].balance)});
  } catch(e){res.status(500).json({success:false,message:'Bet failed!'});}
});

app.post('/api/add-money', async (req,res)=>{
  try {
    const {userId,amount,utrNumber}=req.body; const value=Number(amount); const user=await getUser(userId);
    if(!user)return res.status(404).json({success:false,message:'User not found!'});
    if(!Number.isFinite(value)||value<100)return res.status(400).json({success:false,message:'Minimum Deposit is ₹100!'});
    if(!utrNumber || !String(utrNumber).trim())return res.status(400).json({success:false,message:'Please enter UTR Transaction Number!'});
    const depositResult = await db('INSERT INTO deposits(user_id,amount,utr_number,status) VALUES($1,$2,$3,$4) RETURNING id,created_at',[user.id,value,String(utrNumber).trim(),'PENDING']);
    const deposit = depositResult.rows[0];
    await sendTelegramMessage(
      `<b>📥 New Deposit Request</b>\n\n` +
      `<b>Request ID:</b> #${deposit.id}\n` +
      `<b>User:</b> ${String(user.name).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}\n` +
      `<b>Mobile:</b> ${String(user.mobile)}\n` +
      `<b>Amount:</b> ₹${value.toFixed(2)}\n` +
      `<b>UTR:</b> ${String(utrNumber).trim().replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}\n` +
      `<b>Status:</b> PENDING\n` +
      `<b>Time:</b> ${new Date(deposit.created_at).toLocaleString('en-IN')}`,
      {inline_keyboard:[[
        {text:'✅ APPROVE', callback_data:`deposit:approve:${deposit.id}`},
        {text:'❌ REJECT', callback_data:`deposit:reject:${deposit.id}`}
      ]]}
    );
    const updated=await getUser(userId);
    res.json({success:true,message:`₹${value} Deposit Request Submitted! Admin approval ke baad amount wallet mein add hoga.`,newBalance:Number(updated.balance),status:'PENDING',depositId:deposit.id});
  }catch(e){console.error('Deposit request error:',e);res.status(500).json({success:false,message:'Deposit failed!'});}
});

app.post('/api/withdraw', async (req,res)=>{
  try {
    const {userId,amount,upiId,accountDetails}=req.body; const value=Number(amount); const user=await getUser(userId);
    if(!user)return res.status(404).json({success:false,message:'User not found!'});
    if(value<110)return res.status(400).json({success:false,message:'Minimum Withdrawal is ₹110!'});
    const updated=await db('UPDATE users SET balance=balance-$1 WHERE id=$2 AND balance >= $1 RETURNING balance',[value,user.id]);
    if(!updated.rowCount)return res.status(400).json({success:false,message:'Insufficient Wallet Balance!'});
    await db('INSERT INTO withdrawals(user_id,amount,upi_id,account_details,status) VALUES($1,$2,$3,$4,$5)',[user.id,value,upiId||null,accountDetails||null,'PENDING']);
    res.json({success:true,message:`Withdrawal request of ₹${value} submitted successfully!`,newBalance:Number(updated.rows[0].balance)});
  }catch(e){res.status(500).json({success:false,message:'Withdrawal request failed!'});}
});

// Admin APIs
app.get('/api/admin/users',adminAuth,async(req,res)=>{
  try { const r=await db('SELECT id,name,mobile,balance,is_blocked,created_at FROM users ORDER BY id DESC'); res.json({success:true,users:r.rows.map(u=>({...u,balance:Number(u.balance)}))}); }
  catch(e){res.status(500).json({success:false,message:'Failed to load users'});}
});
app.post('/api/admin/users/:id/block',adminAuth,async(req,res)=>{try{await db('UPDATE users SET is_blocked=true WHERE id=$1',[req.params.id]);res.json({success:true});}catch(e){res.status(500).json({success:false,message:'Failed'});}});
app.post('/api/admin/users/:id/unblock',adminAuth,async(req,res)=>{try{await db('UPDATE users SET is_blocked=false WHERE id=$1',[req.params.id]);res.json({success:true});}catch(e){res.status(500).json({success:false,message:'Failed'});}});
app.delete('/api/admin/users/:id',adminAuth,async(req,res)=>{try{await db('DELETE FROM users WHERE id=$1',[req.params.id]);res.json({success:true});}catch(e){res.status(500).json({success:false,message:'Failed'});}});
app.get('/api/admin/deposits',adminAuth,async(req,res)=>{try{const r=await db(`SELECT d.*,u.name,u.mobile FROM deposits d JOIN users u ON u.id=d.user_id ORDER BY d.id DESC`);res.json({success:true,deposits:r.rows});}catch(e){res.status(500).json({success:false,message:'Failed'});}});
app.post('/api/admin/deposits/:id/approve',adminAuth,async(req,res)=>{
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const d=await client.query("SELECT * FROM deposits WHERE id=$1 FOR UPDATE",[req.params.id]);
      if(!d.rowCount||d.rows[0].status!=='PENDING'){await client.query('ROLLBACK');return res.json({success:false,message:'Already processed'});}
      await client.query("UPDATE deposits SET status='APPROVED' WHERE id=$1",[req.params.id]);
      await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2',[d.rows[0].amount,d.rows[0].user_id]);
      await client.query('COMMIT');
      await sendTelegramMessage(`<b>✅ Deposit Approved</b>\n\n<b>Request ID:</b> #${req.params.id}\n<b>Amount:</b> ₹${Number(d.rows[0].amount).toFixed(2)}\n<b>Status:</b> APPROVED`);
      res.json({success:true,message:'Deposit approved and wallet credited.'});
    } catch(e){try{await client.query('ROLLBACK')}catch(_){}throw e;} finally {client.release();}
  } catch(e){console.error('Deposit approve error:',e);res.status(500).json({success:false,message:'Failed'});}
});
app.post('/api/admin/deposits/:id/reject',adminAuth,async(req,res)=>{
  try {
    const r=await db("UPDATE deposits SET status='REJECTED' WHERE id=$1 AND status='PENDING' RETURNING id,amount",[req.params.id]);
    if (r.rowCount) await sendTelegramMessage(`<b>❌ Deposit Rejected</b>\n\n<b>Request ID:</b> #${req.params.id}\n<b>Amount:</b> ₹${Number(r.rows[0].amount).toFixed(2)}\n<b>Status:</b> REJECTED`);
    res.json({success:!!r.rowCount,message:r.rowCount?'Deposit rejected.':'Already processed'});
  } catch(e){res.status(500).json({success:false,message:'Failed'});}
});
app.get('/api/admin/withdrawals',adminAuth,async(req,res)=>{try{const r=await db(`SELECT w.*,u.name,u.mobile FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.id DESC`);res.json({success:true,withdrawals:r.rows});}catch(e){res.status(500).json({success:false,message:'Failed'});}});
app.post('/api/admin/withdrawals/:id/approve',adminAuth,async(req,res)=>{try{const r=await db("UPDATE withdrawals SET status='APPROVED' WHERE id=$1 AND status='PENDING' RETURNING id",[req.params.id]);res.json({success:!!r.rowCount,message:r.rowCount?'Approved':'Already processed'});}catch(e){res.status(500).json({success:false,message:'Failed'});}});
app.post('/api/admin/withdrawals/:id/reject',adminAuth,async(req,res)=>{try{await db('BEGIN');const w=await db("SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE",[req.params.id]);if(!w.rowCount||w.rows[0].status!=='PENDING'){await db('ROLLBACK');return res.json({success:false,message:'Already processed'});}await db('UPDATE withdrawals SET status=\'REJECTED\' WHERE id=$1',[req.params.id]);await db('UPDATE users SET balance=balance+$1 WHERE id=$2',[w.rows[0].amount,w.rows[0].user_id]);await db('COMMIT');res.json({success:true});}catch(e){try{await db('ROLLBACK')}catch(_){}res.status(500).json({success:false,message:'Failed'});}});


// User transaction history APIs
app.get('/api/user/:userId/deposits', async (req,res)=>{
  try {
    const user = await getUser(req.params.userId);
    if(!user) return res.status(404).json({success:false,message:'User not found'});
    const r = await db('SELECT id, amount, utr_number, status, created_at FROM deposits WHERE user_id=$1 ORDER BY id DESC LIMIT 100',[user.id]);
    res.json({success:true,deposits:r.rows.map(x=>({...x,amount:Number(x.amount)}))});
  } catch(e){ console.error('Deposit history error:',e); res.status(500).json({success:false,message:'Failed to load deposit history'}); }
});

app.get('/api/user/:userId/withdrawals', async (req,res)=>{
  try {
    const user = await getUser(req.params.userId);
    if(!user) return res.status(404).json({success:false,message:'User not found'});
    const r = await db('SELECT id, amount, upi_id, status, created_at FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 100',[user.id]);
    res.json({success:true,withdrawals:r.rows.map(x=>({...x,amount:Number(x.amount)}))});
  } catch(e){ console.error('Withdrawal history error:',e); res.status(500).json({success:false,message:'Failed to load withdrawal history'}); }
});

app.get('/api/health',(req,res)=>res.json({success:true,database:!!pool}));

// Serve the original game and admin panel from the same Render service.
app.use(express.static(__dirname));
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'admin.html')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));

initDb().then(()=>app.listen(PORT,()=>{console.log(`Server running on port ${PORT}`); telegramPollLoop();})).catch(err=>{console.error('DB init failed:',err);process.exit(1);});
