import mongoose from "mongoose";

// Хранит пару: кто смотрит (viewerId) → чей список (ownerId)
const bindingSchema = new mongoose.Schema({
  viewerId: { type: String, required: true, unique: true },
  ownerId: { type: String, required: true },
});

export default mongoose.model("Binding", bindingSchema);
