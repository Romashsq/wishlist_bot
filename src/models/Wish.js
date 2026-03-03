import mongoose from "mongoose";
import { encrypt, decrypt } from "../utils/crypto.js";

// Fields that are encrypted at rest in MongoDB.
// NOT encrypted: id, ownerId, buyerId, status, priority, createdAt, updatedAt
// (these are needed for queries and filtering)
const ENCRYPTED_FIELDS = ["title", "link", "price", "photoFileId", "photoUrl", "noteFromBuyer"];

const wishSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  ownerId: { type: String, required: true },
  buyerId: { type: String, default: null },
  title: { type: String, required: true },
  link: { type: String, default: "none" },
  price: { type: String, default: "" },
  photoFileId: { type: String, default: null },
  photoUrl: { type: String, default: null },
  priority: { type: Number, default: 0 },
  status: { type: String, default: "new" },
  noteFromBuyer: { type: String, default: "" },
  holiday:       { type: String, default: null },
  pledgedBy:     { type: String, default: null },
  pledgedByName: { type: String, default: null },
  pledgeStatus:  { type: String, default: "planned" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// ─── Encrypt before inserting / saving ────────────────────────────────────
wishSchema.pre("save", function () {
  for (const field of ENCRYPTED_FIELDS) {
    if (this[field] != null) this[field] = encrypt(this[field]);
  }
});

// Decrypt after save so the in-memory doc stays readable
wishSchema.post("save", function (doc) {
  for (const field of ENCRYPTED_FIELDS) {
    if (doc[field] != null) doc[field] = decrypt(doc[field]);
  }
});

// ─── Encrypt fields in findOneAndUpdate calls ─────────────────────────────
wishSchema.pre("findOneAndUpdate", function () {
  const update = this.getUpdate();
  for (const field of ENCRYPTED_FIELDS) {
    if (update[field] != null) update[field] = encrypt(update[field]);
    if (update.$set?.[field] != null) update.$set[field] = encrypt(update.$set[field]);
  }
});

// ─── Decrypt after all read operations ────────────────────────────────────
function decryptDocs(result) {
  if (!result) return;
  const docs = Array.isArray(result) ? result : [result];
  for (const doc of docs) {
    if (!doc) continue;
    for (const field of ENCRYPTED_FIELDS) {
      if (doc[field] != null) doc[field] = decrypt(doc[field]);
    }
  }
}

wishSchema.post("find", decryptDocs);
wishSchema.post("findOne", decryptDocs);
wishSchema.post("findOneAndUpdate", decryptDocs);

export default mongoose.model("Wish", wishSchema);
