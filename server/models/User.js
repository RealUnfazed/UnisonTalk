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
    password: {
      type: String,
      required: true,
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
    // This is the ONLY key material the server ever sees — the matching
    // private key is generated and stored client-side and never leaves
    // the browser. See client/src/crypto/webcrypto.js.
    publicKey: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

// Hash the password whenever it is created or changed, never store it in plain text.
userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
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
