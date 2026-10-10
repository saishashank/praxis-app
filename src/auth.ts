import NextAuth from "next-auth";
import { buildAuthConfig } from "@/lib/auth/config";

export const { handlers, auth, signIn, signOut } = NextAuth(buildAuthConfig());
