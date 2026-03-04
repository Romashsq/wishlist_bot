import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  firstName: { type: String, default: "Unknown" },
  username:  { type: String, default: null },
  role: { type: String, default: "owner" },
  partnerIds: { type: [String], default: [] },
  lang: { type: String, default: "ru" },
  langSet: { type: Boolean, default: false },
  receiveGiftNotifs: { type: Boolean, default: false },
  receivePledgeNotifs: { type: Boolean, default: true },
  birthday: { type: String, default: null }, // "MM-DD" e.g. "03-15"
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("User", userSchema);
