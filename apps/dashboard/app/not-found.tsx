import Link from 'next/link';

/** One answer for "does not exist" and "you may not see it". */
export default function NotFound() {
  return (
    <div className="p-[48px] text-center">
      <p className="text-[14px]">Not found.</p>
      <p className="mt-[8px] text-[13px] text-[--color-ink-3]">
        Either there is nothing here, or it is not yours to see.
      </p>
      <Link href="/" className="mt-[24px] inline-block text-[13px] underline underline-offset-[3px]">
        Back to the overview
      </Link>
    </div>
  );
}
