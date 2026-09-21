const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 24,
      match: /^[a-zA-Z0-9_]+$/,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    // Not `required` at the schema level, because a Phasetime SSO signup
    // never sets one at all — see controllers/ssoController.js. Local
    // registration (controllers/authController.js) enforces its own
    // "password is required" check before ever calling User.create().
    password: {
      type: String,
      default: null,
    },
    // Set once a person signs in with (or links) Phasetime SSO —
    // see controllers/ssoController.js and README.md's "Phasetime SSO"
    // section. `sparse: true` lets any number of accounts have this
    // unset (null) without violating the uniqueness constraint; only
    // actual Phasetime IDs need to be unique.
    phasetimeId: {
      type: String,
      default: null,
      unique: true,
      sparse: true,
    },
    isOnline: {
      type: Boolean,
      default: false,
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
    // Base64-encoded SPKI export of the user's ECDH (P-256) public key.
    // Only ever needed for Secret Chats (see models/Chat.js) — Cloud
    // Chats don't use client-side encryption at all, so most accounts
    // may never populate this. Safe to be fully public: anyone can use it
    // to encrypt something to this user, but it reveals nothing about
    // their private key, which never leaves their device.
    publicKey: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

// Hash the password whenever it is created or changed, never store it in plain text.
userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password') || !this.password) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// A Phasetime-only account (no local password ever set) should just
// never match a password login attempt, not throw when bcrypt is handed
// a null hash.
userSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!this.password) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.password);
};

// A deterministic avatar so every user has a face without needing uploads.
userSchema.methods.avatarUrl = function avatarUrl() {
  const encoded = encodeURIComponent(this.username);
  return `https://ui-avatars.com/api/?name=${encoded}&background=random&bold=true`;
};

// Never leak the password hash to the client, even by accident.
userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.password;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
