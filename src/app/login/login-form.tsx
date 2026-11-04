"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "./actions";

const MESSAGES = {
  invalid: "Sai tên đăng nhập hoặc mật khẩu",
  rate_limited: "Thử đăng nhập quá nhiều lần, vui lòng đợi 1 phút",
} as const;

export function LoginForm() {
  const [state, action] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <form action={action}>
      {state.error && <p role="alert">{MESSAGES[state.error]}</p>}
      <label>
        Tên đăng nhập <input name="username" required autoComplete="username" />
      </label>
      <label>
        Mật khẩu <input name="password" type="password" required autoComplete="current-password" />
      </label>
      <button type="submit">Đăng nhập</button>
    </form>
  );
}
