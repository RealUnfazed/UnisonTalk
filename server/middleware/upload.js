const multer = require('multer');

// Attachments arrive in one of two shapes, decided by the chat they belong
// to: opaque AES-GCM ciphertext for a Secret Chat, or a normal file for a
// Cloud Chat (controllers/uploadController.js branches on it).
//
// The upload is held in memory (20 MB cap) and handed to the storage layer
// by the controller only AFTER it has been validated: a rejected request
// writes nothing anywhere. The stored name is random — the client's
// filename and extension are never used — and how a file is served (inline
// image vs. sandboxed download) is decided from the validated message
// record at request time (see serveAttachment).
module.exports = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
