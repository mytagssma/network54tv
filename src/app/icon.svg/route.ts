import { cookies } from "next/headers";
import { n54IconSvg, sanitizeAccent } from "@/lib/n54-icon";

export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const rawAccent = cookieStore.get("accent")?.value;
  const accent = sanitizeAccent(rawAccent);

  return new Response(n54IconSvg(accent), {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
