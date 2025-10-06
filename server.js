/**
 * Full server.js — copy-paste runnable
 *
 * BEFORE RUNNING:
 * 1) Install dependencies:
 *    npm install express http mongoose socket.io cors dotenv @sendgrid/mail
 * 2) (Optional but recommended) Create a .env with:
 *    MONGO_URI=your_mongo_uri_here
 *    PORT=4000
 *    SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxxx
 *
 * This file will fall back to the provided API key constant below if process.env.SENDGRID_API_KEY is not set.
 *
 * NOTE: Storing API keys directly in files is insecure for production. Use environment variables or secret managers.
 */

const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

// ---------------------- SendGrid Setup ----------------------
const sgMail = require('@sendgrid/mail');

// === Constants you asked to be definable ===
const SPECIAL_USER = 'a'; // change later easily
const FROM_EMAIL = 'eduanikterajmandal7@gmail.com'; // verified sender in SendGrid (you said this)
const ALERT_EMAIL = 'aniketrajmandal7@gmail.com'; // recipient for alerts

// The user-provided API key is used as a fallback if no env var is provided.
// Recommended: set SENDGRID_API_KEY in .env instead of hardcoding.
const FALLBACK_SENDGRID_KEY = process.env.SENDGRID_API_KEY;

const sendgridKey = process.env.SENDGRID_API_KEY || FALLBACK_SENDGRID_KEY;
sgMail.setApiKey(sendgridKey);
console.log('📬 SendGrid initialized (using env key?' + (process.env.SENDGRID_API_KEY ? ' yes' : ' no (using fallback)') + ')');

// ---------------------- App setup ----------------------
const app = express();

app.use(cors({
  origin: 'https://20years-jee-pyq.netlify.app',
  credentials: true,
}));
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: 'https://20years-jee-pyq.netlify.app',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// ---------------------- MongoDB ----------------------
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost/chatapp')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.log('❌ MongoDB connection error:', err));

// ---------------------- Schemas ----------------------
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  lastSeen: { type: Date, default: null }
});

const messageSchema = new mongoose.Schema({
  sender: String,
  receiver: String,
  message: String,
  timestamp: { type: Date, default: Date.now },
  read: { type: Boolean, default: false },
  tag: { type: String, default: null },
  reactions: [
    {
      user: String,
      emoji: String
    }
  ],
  edited: { type: Boolean, default: false },
  editedAt: { type: Date, default: null },
  deleted: { type: Boolean, default: false },
  deletedBy: { type: String, default: null }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// ---------------------- Runtime state ----------------------
let onlineUsers = {}; // username -> socket.id

// ---------------------- Helper: send alert email ----------------------
async function sendLoginAlertEmail(triggerUsername) {
  const timestamp = new Date().toISOString();
  const subject = `Alert: user '${triggerUsername}' logged in`;
  const text = `User '${triggerUsername}' logged into the app on ${timestamp}.\n\nThis is an automated notification.`;

  const msg = {
    to: ALERT_EMAIL,
    from: FROM_EMAIL,
    subject,
    text
  };

  try {
    console.log(`📨 Sending alert email to ${ALERT_EMAIL} about user '${triggerUsername}'...`);
    const response = await sgMail.send(msg);
    // sgMail.send returns an array of responses; log status
    console.log('✅ SendGrid send response:', Array.isArray(response) ? response.map(r => r.statusCode) : response.statusCode);
    return { success: true, info: response };
  } catch (err) {
    // SendGrid errors often have response.body for details
    console.error('❌ Error sending alert email:', err?.message || err);
    if (err?.response?.body) {
      console.error('SendGrid response body:', err.response.body);
    }
    return { success: false, error: err };
  }
}

// ---------------------- Socket.IO ----------------------
io.on('connection', (socket) => {
  console.log('🔌 New socket connection:', socket.id);

  // login: associate username -> socket.id
  socket.on('login', async (username) => {
    try {
      console.log(`➡️  login event received from socket ${socket.id} for username: '${username}'`);
      onlineUsers[username] = socket.id;

      // clear lastSeen when user logs in (they are online)
      await User.findOneAndUpdate({ username }, { lastSeen: null });
      console.log(`🟢 Marked '${username}' as online.`);

      io.emit('onlineUsers', Object.keys(onlineUsers));
      console.log('📣 Broadcasted updated onlineUsers:', Object.keys(onlineUsers));

      // If this is the special user, send an email alert
      if (username === SPECIAL_USER) {
        console.log(`🔎 Username matches SPECIAL_USER ('${SPECIAL_USER}'). Preparing to send alert email.`);
        const result = await sendLoginAlertEmail(username);
        if (result.success) {
          console.log(`✅ Alert email successfully sent for '${username}'.`);
        } else {
          console.error(`⚠️ Failed to send alert email for '${username}'. See error above.`);
        }
      } else {
        console.log(`ℹ️ Username '${username}' does not match SPECIAL_USER ('${SPECIAL_USER}'), no email sent.`);
      }
    } catch (err) {
      console.log('Error during login handler:', err);
    }
  });

  // logout: remove mapping and set lastSeen
  socket.on('logout', async (username) => {
    try {
      console.log(`⬅️ logout event received for username: '${username}'`);
      delete onlineUsers[username];

      // set lastSeen on explicit logout
      await User.findOneAndUpdate({ username }, { lastSeen: new Date() });
      console.log(`🔴 Set lastSeen for '${username}'.`);

      io.emit('onlineUsers', Object.keys(onlineUsers));
      console.log('📣 Broadcasted updated onlineUsers:', Object.keys(onlineUsers));
    } catch (err) {
      console.log('Error during logout handler:', err);
    }
  });

  socket.on('disconnect', async () => {
    try {
      console.log(`❌ Socket disconnected: ${socket.id}`);
      let disconnectedUser = null;
      for (const [username, id] of Object.entries(onlineUsers)) {
        if (id === socket.id) {
          disconnectedUser = username;
          delete onlineUsers[username];
        }
      }

      if (disconnectedUser) {
        await User.findOneAndUpdate({ username: disconnectedUser }, { lastSeen: new Date() });
        console.log(`🔴 Set lastSeen for disconnected user '${disconnectedUser}'.`);
      }

      io.emit('onlineUsers', Object.keys(onlineUsers));
      console.log('📣 Broadcasted updated onlineUsers after disconnect:', Object.keys(onlineUsers));
    } catch (err) {
      console.log('Error on disconnect:', err);
    }
  });

  socket.on('joinRoom', (room) => {
    socket.join(room);
    console.log(`📥 Socket ${socket.id} joined room: ${room}`);
  });

  // Send message
  socket.on('sendMessage', async ({ sender, receiver, message, tag, room }) => {
    try {
      const msg = new Message({ sender, receiver, message, tag: tag || null });
      await msg.save();
      io.to(room).emit('newMessage', msg);
      console.log(`💬 Message saved and emitted to room ${room} — from ${sender} to ${receiver}`);
    } catch (err) {
      console.log('Error saving message:', err);
    }
  });

  // Add / remove reaction
  socket.on('addReaction', async ({ messageId, user, emoji, room }) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return;

      const existingIndex = msg.reactions.findIndex(r => r.user === user);

      if (existingIndex !== -1) {
        if (msg.reactions[existingIndex].emoji === emoji) {
          msg.reactions.splice(existingIndex, 1);
        } else {
          msg.reactions[existingIndex].emoji = emoji;
        }
      } else {
        msg.reactions.push({ user, emoji });
      }

      await msg.save();
      io.to(room).emit('messageUpdated', msg);
      console.log(`😊 Reaction updated for message ${messageId} by ${user}`);
    } catch (err) {
      console.log('Error in addReaction:', err);
    }
  });

  // Mark messages as read
  socket.on('markRead', async ({ user1, user2 }) => {
    try {
      await Message.updateMany(
        { sender: user2, receiver: user1, read: false },
        { $set: { read: true } }
      );
      const senderSocketId = onlineUsers[user2];
      if (senderSocketId) {
        io.to(senderSocketId).emit('refresh');
      }
      console.log(`📗 Marked messages read between ${user1} and ${user2}`);
    } catch (err) {
      console.log('Error in markRead:', err);
    }
  });

  // Typing indicator
  socket.on('typing', ({ sender, receiver, isTyping }) => {
    const room = `${receiver}_${sender}`;
    socket.to(room).emit('typing', { sender, isTyping });
    // Minimal logging to avoid flooding console
    if (isTyping) {
      console.log(`✍️ ${sender} is typing to ${receiver}`);
    }
  });

  // Clear chat
  socket.on('clearChat', async ({ user1, user2 }) => {
    try {
      await Message.deleteMany({
        $or: [
          { sender: user1, receiver: user2 },
          { sender: user2, receiver: user1 }
        ]
      });
      io.to(`${user1}_${user2}`).emit('cleared');
      io.to(`${user2}_${user1}`).emit('cleared');
      console.log(`🧹 Cleared chat between ${user1} and ${user2}`);
    } catch (err) {
      console.log('Error clearing chat via socket:', err);
    }
  });

  // Delete message (sender OR receiver)
  socket.on('deleteMessage', async ({ messageId, user, room }) => {
    try {
      if (!messageId || !user) return;

      const msg = await Message.findById(messageId);
      if (!msg) return;

      if (user !== msg.sender && user !== msg.receiver) {
        return;
      }

      msg.deleted = true;
      msg.deletedBy = user;
      msg.message = `${user} deleted this message`;
      await msg.save();

      io.to(room).emit('messageUpdated', msg);
      console.log(`🗑️ Message ${messageId} marked deleted by ${user}`);
    } catch (err) {
      console.log('Error in deleteMessage:', err);
    }
  });

  // Edit message (ONLY sender)
  socket.on('editMessage', async ({ messageId, user, newText, room }) => {
    try {
      if (!messageId || !user || typeof newText !== 'string') return;

      const msg = await Message.findById(messageId);
      if (!msg) return;

      if (user !== msg.sender) {
        return;
      }

      msg.message = newText;
      msg.edited = true;
      msg.editedAt = new Date();
      await msg.save();

      io.to(room).emit('messageUpdated', msg);
      console.log(`✏️ Message ${messageId} edited by ${user}`);
    } catch (err) {
      console.log('Error in editMessage:', err);
    }
  });

});

// ---------------------- REST API ----------------------

// Signup API
app.post('/signup', async (req, res) => {
  try {
    const { username, password } = req.body;
    const exists = await User.findOne({ username });
    if (exists) return res.status(400).json({ message: 'Username exists' });
    await new User({ username, password }).save();
    console.log(`🆕 User signed up: ${username}`);
    res.json({ success: true });
  } catch (err) {
    console.log('Error in /signup:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Login API
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || user.password !== password)
      return res.status(400).json({ message: 'Invalid' });
    console.log(`🔐 REST login success for ${username}`);
    res.json({ success: true });
  } catch (err) {
    console.log('Error in /login:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get User by Username (includes online + lastSeen)
app.get('/user/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ message: 'Not found' });

    res.json({
      success: true,
      username: user.username,
      online: onlineUsers[user.username] ? true : false,
      lastSeen: user.lastSeen || null
    });
  } catch (err) {
    console.log('Error in /user/:username:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get Messages Between Users
app.get('/messages', async (req, res) => {
  try {
    const { user1, user2 } = req.query;
    const messages = await Message.find({
      $or: [
        { sender: user1, receiver: user2 },
        { sender: user2, receiver: user1 }
      ]
    }).sort('timestamp');
    res.json(messages);
  } catch (err) {
    console.log('Error in /messages:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin Panel — All Users Info
app.get('/admin', async (req, res) => {
  try {
    const { user } = req.query;
    if (user !== 'aniketadmin') return res.status(403).json({ message: 'Unauthorized' });

    const users = await User.find();
    const userData = users.map(u => ({
      username: u.username,
      password: '•••••••',
      online: onlineUsers[u.username] ? true : false,
      lastSeen: u.lastSeen || null
    }));
    res.json(userData);
  } catch (err) {
    console.log('Error in /admin:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Pairwise Analytics
app.get('/analytics', async (req, res) => {
  try {
    const { user } = req.query;
    if (user !== 'aniketadmin') return res.status(403).json({ message: 'Unauthorized' });

    const messages = await Message.find();
    const pairMap = {};

    for (const msg of messages) {
      const pair = [msg.sender, msg.receiver].sort().join('-');
      if (!pairMap[pair]) pairMap[pair] = [];
      pairMap[pair].push(msg);
    }

    const analytics = Object.entries(pairMap).map(([pair, msgs]) => ({
      pair,
      count: msgs.length,
      estimatedKB: ((JSON.stringify(msgs).length / 1024).toFixed(2)) + ' KB'
    }));

    res.json(analytics);
  } catch (err) {
    console.log('Error in /analytics:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin Trigger: Clear Chat of Any Pair
app.delete('/analytics/clear', async (req, res) => {
  try {
    const { user, user1, user2 } = req.body;
    if (user !== 'aniketadmin') return res.status(403).json({ message: 'Unauthorized' });

    await Message.deleteMany({
      $or: [
        { sender: user1, receiver: user2 },
        { sender: user2, receiver: user1 }
      ]
    });
    console.log(`🗑️ Admin cleared chat between ${user1} and ${user2}`);
    res.json({ success: true, cleared: `${user1} ↔ ${user2}` });
  } catch (err) {
    console.log('Error in DELETE /analytics/clear:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete a user (Admin only)
app.delete('/user/:username', async (req, res) => {
  try {
    const { user } = req.body;
    if (user !== 'aniketadmin') return res.status(403).json({ message: 'Unauthorized' });

    const username = req.params.username;
    await User.deleteOne({ username });
    await Message.deleteMany({ $or: [{ sender: username }, { receiver: username }] });
    console.log(`🗑️ Admin deleted user ${username} and associated messages`);
    res.json({ success: true });
  } catch (err) {
    console.log('Error in DELETE /user/:username:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ---------------------- Start server ----------------------
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
