import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./password";

export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 50;

export const isValidUsername = (u: unknown): u is string =>
  typeof u === "string" && u.length >= MIN_USERNAME_LENGTH && u.length <= MAX_USERNAME_LENGTH;
export const isValidPassword = (p: unknown): p is string =>
  typeof p === "string" && p.length >= MIN_PASSWORD_LENGTH && p.length <= MAX_PASSWORD_LENGTH;
