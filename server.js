const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

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

// ✅ MongoDB connection
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost/chatapp')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.log(err));

// ---------------------- Schemas ----------------------
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  // added lastSeen to persist last online time
  lastSeen: { type: Date, default: null }
});

// Message schema with tag + reactions + edited/deleted metadata
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
  // New fields for edit/delete features
  edited: { type: Boolean, default: false },
  editedAt: { type: Date, default: null },
  deleted: { type: Boolean, default: false },
  deletedBy: { type: String, default: null }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// ---------------------- Runtime state ----------------------
let onlineUsers = {}; // username -> socket.id

// ---------------------- Socket.IO ----------------------
io.on('connection', (socket) => {
  // login: associate username -> socket.id
  socket.on('login', async (username) => {
    try {
      onlineUsers[username] = socket.id;

      // clear lastSeen when user logs in (they are online)
      await User.findOneAndUpdate({ username }, { lastSeen: null });

      io.emit('onlineUsers', Object.keys(onlineUsers));
    } catch (err) {
      console.log('Error during login handler:', err);
    }
  });

  // logout: remove mapping and set lastSeen
  socket.on('logout', async (username) => {
    try {
      delete onlineUsers[username];

      // set lastSeen on explicit logout
      await User.findOneAndUpdate({ username }, { lastSeen: new Date() });

      io.emit('onlineUsers', Object.keys(onlineUsers));
    } catch (err) {
      console.log('Error during logout handler:', err);
    }
  });

  socket.on('disconnect', async () => {
    try {
      // find username mapped to this socket id
      let disconnectedUser = null;
      for (const [username, id] of Object.entries(onlineUsers)) {
        if (id === socket.id) {
          disconnectedUser = username;
          delete onlineUsers[username];
        }
      }

      // set lastSeen for the disconnected user (if found)
      if (disconnectedUser) {
        await User.findOneAndUpdate({ username: disconnectedUser }, { lastSeen: new Date() });
      }

      io.emit('onlineUsers', Object.keys(onlineUsers));
    } catch (err) {
      console.log('Error on disconnect:', err);
    }
  });

  socket.on('joinRoom', (room) => socket.join(room));

  // Send message (unchanged behavior)
  socket.on('sendMessage', async ({ sender, receiver, message, tag, room }) => {
    try {
      const msg = new Message({ sender, receiver, message, tag: tag || null });
      await msg.save();
      io.to(room).emit('newMessage', msg);
    } catch (err) {
      console.log('Error saving message:', err);
    }
  });

  // Add / remove reaction (unchanged)
  socket.on('addReaction', async ({ messageId, user, emoji, room }) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return;

      // Check if user already reacted with any emoji
      const existingIndex = msg.reactions.findIndex(r => r.user === user);

      if (existingIndex !== -1) {
        if (msg.reactions[existingIndex].emoji === emoji) {
          // Same emoji → remove (unreact)
          msg.reactions.splice(existingIndex, 1);
        } else {
          // Replace with new emoji
          msg.reactions[existingIndex].emoji = emoji;
        }
      } else {
        // Add new reaction
        msg.reactions.push({ user, emoji });
      }

      await msg.save();
      io.to(room).emit('messageUpdated', msg);
    } catch (err) {
      console.log('Error in addReaction:', err);
    }
  });

  // Mark messages as read (unchanged)
  socket.on('markRead', async ({ user1, user2 }) => {
    try {
      await Message.updateMany(
        { sender: user2, receiver: user1, read: false },
        { $set: { read: true } }
      );
      // Only notify the sender (user2) if they are online
      const senderSocketId = onlineUsers[user2];
      if (senderSocketId) {
        io.to(senderSocketId).emit('refresh');
      }
    } catch (err) {
      console.log('Error in markRead:', err);
    }
  });

  // Typing indicator (unchanged)
  socket.on('typing', ({ sender, receiver, isTyping }) => {
    const room = `${receiver}_${sender}`;
    socket.to(room).emit('typing', { sender, isTyping });
  });

  // Clear chat (unchanged)
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
    } catch (err) {
      console.log('Error clearing chat via socket:', err);
    }
  });

  // ---------------------- New: Delete Message (sender OR receiver) ----------------------
  // Payload expected: { messageId, user, room }
  // Both sender and receiver are allowed to trigger delete.
  socket.on('deleteMessage', async ({ messageId, user, room }) => {
    try {
      if (!messageId || !user) return;

      const msg = await Message.findById(messageId);
      if (!msg) return;

      // Only allow if the requesting user is either sender or receiver
      if (user !== msg.sender && user !== msg.receiver) {
        // unauthorized attempt - ignore
        return;
      }

      // Mark deleted and note who deleted it. Replace displayed text with "<username> deleted this message"
      msg.deleted = true;
      msg.deletedBy = user;
      msg.message = `${user} deleted this message`;
      await msg.save();

      // Broadcast the updated message to the room
      io.to(room).emit('messageUpdated', msg);
    } catch (err) {
      console.log('Error in deleteMessage:', err);
    }
  });

  // ---------------------- New: Edit Message (ONLY sender) ----------------------
  // Payload expected: { messageId, user, newText, room }
  socket.on('editMessage', async ({ messageId, user, newText, room }) => {
    try {
      if (!messageId || !user || typeof newText !== 'string') return;

      const msg = await Message.findById(messageId);
      if (!msg) return;

      // Only the original sender can edit
      if (user !== msg.sender) {
        // unauthorized attempt - ignore
        return;
      }

      // Update content and mark edited
      msg.message = newText;
      msg.edited = true;
      msg.editedAt = new Date();
      await msg.save();

      // Broadcast updated message to the room
      io.to(room).emit('messageUpdated', msg);
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
    res.json({ success: true });
  } catch (err) {
    console.log('Error in /login:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get User by Username (now includes online + lastSeen)
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
    res.json({ success: true });
  } catch (err) {
    console.log('Error in DELETE /user/:username:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ---------------------- Start server ----------------------
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
