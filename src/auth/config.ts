import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authorizeCredentials } from "./authorize";
import { buildSessionUser } from "./callbacks";

declare module "next-auth" {
  interface Session {
    user: { id: number; username: string; role: "admin" | "user"; active: boolean };
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET,
  session: { strategy: "jwt", maxAge: 60 * 60 * 12 },
  trustHost: true, // chạy sau Caddy
  pages: { signIn: "/login" },
  useSecureCookies: process.env.NODE_ENV === "production",
  cookies: {
    sessionToken: {
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
  },
  providers: [
    Credentials({
      credentials: { username: {}, password: {} },
      async authorize(c) {
        if (typeof c?.username !== "string" || typeof c?.password !== "string") return null;
        const u = await authorizeCredentials(c.username, c.password);
        return u ? { id: String(u.id), name: u.username, role: u.role } : null;
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.uid = Number(user.id);
        token.username = user.name as string;
        token.role = (user as { role: "admin" | "user" }).role;
      }
      return token;
    },
    async session({ session, token }) {
      session.user = (await buildSessionUser(token as Record<string, unknown>)) as typeof session.user;
      return session;
    },
  },
});
