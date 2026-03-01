require("dotenv").config();

const app = require("./src/app");
const connectDB = require("./src/config/db");

const PORT = Number(process.env.PORT) || 4000;

async function startServer() {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`Focus Mission backend listening on port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
