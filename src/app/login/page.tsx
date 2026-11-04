import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { auth, signIn } from "@/auth/config";

export const dynamic = "force-dynamic";

async function login(formData: FormData) {
  "use server";
  try {
    await signIn("credentials", {
      username: formData.get("username"),
      password: formData.get("password"),
      redirectTo: "/",
    });
  } catch (e) {
    if (e instanceof AuthError) redirect("/login?error=1");
    throw e;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if ((await auth())?.user) redirect("/");
  const { error } = await searchParams;
  return (
    <main>
      <h1>Đăng nhập</h1>
      {error && <p role="alert">Sai tên đăng nhập hoặc mật khẩu</p>}
      <form action={login}>
        <label>
          Tên đăng nhập <input name="username" required autoComplete="username" />
        </label>
        <label>
          Mật khẩu <input name="password" type="password" required autoComplete="current-password" />
        </label>
        <button type="submit">Đăng nhập</button>
      </form>
    </main>
  );
}
