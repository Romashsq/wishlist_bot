import mongoose from "mongoose";

// fromUserId може бачити хотілки toUserId
const partnershipSchema = new mongoose.Schema({
  fromUserId: { type: String, required: true },
  toUserId:   { type: String, required: true },
  role:       { type: String, default: "Партнёр" },
  createdAt:  { type: Date, default: Date.now },
});

partnershipSchema.index({ fromUserId: 1, toUserId: 1 }, { unique: true });

export default mongoose.model("Partnership", partnershipSchema);
