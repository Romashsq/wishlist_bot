import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  firstName: { type: String, default: "Unknown" },
  role: { type: String, default: "owner" },
  partnerIds: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("User", userSchema);
