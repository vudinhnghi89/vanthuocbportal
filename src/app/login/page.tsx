import { redirect } from "next/navigation";
import { auth } from "@/auth/config";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // Tài khoản bị khóa không được chuyển hướng, nếu không sẽ lặp với proxy.
  if ((await auth())?.user?.active) redirect("/");
  return (
    <main>
      <h1>Đăng nhập</h1>
      <LoginForm />
    </main>
  );
}
