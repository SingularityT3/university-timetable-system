/** Print a PBKDF2 hash for an AppUser row:  npm run hash-password -- <password> */
import { hashPassword } from "@/lib/server/auth";

const args = process.argv.slice(2);
if (args.length === 1) {
  console.log(hashPassword(args[0]));
} else {
  console.log("usage: npm run hash-password -- <password>");
  process.exitCode = 2;
}
