// Artwork agent: checks a customer's upload before it goes to print, the way
// a proofing team would. The verdict is code: every check is a measurement
// with a limit in the policy table (see src/tools/artwork.ts). The model looks
// at the proof and writes the customer's note: what is wrong and how to fix it.
//
// Why the model doesn't decide: on the eval (eval/artworkEval.ts) qwen3.5:9b's
// eyes caught 0 of 5 cut-line problems, approved 7 bad files of 22, and its
// own extra opinions rejected good files. The measurements caught everything.
// So its extra concerns are kept as advisory notes for a human, never a block.
import { z } from 'zod';
import { runAgent, type AgentResult } from './runAgent.js';
import { measureArtwork, measuredIssues, proofPreview, type ArtworkFacts, type ArtworkLimits } from '../tools/artwork.js';

export const ISSUES = ['low_resolution', 'background_not_removed', 'text_near_edge', 'upscaled_blurry', 'low_contrast'] as const;
export type Issue = (typeof ISSUES)[number];

export const ArtworkOutput = z.object({
  customer_note: z.string().min(10).max(700),
  extra_concerns: z.array(z.string().max(200)).max(3),
});
export type ArtworkOutput = z.infer<typeof ArtworkOutput>;

// What a note must mention for each issue, so the customer knows the fix.
const NOTE_COVERS: Record<Issue, RegExp> = {
  low_resolution: /resolution|dpi|pixel|larger|bigger|too small/i,
  background_not_removed: /background|transparen/i,
  text_near_edge: /edge|inward|cut ?line|margin|border/i,
  upscaled_blurry: /blur|soft|sharp|vector|original|upscal|enlarg/i,
  low_contrast: /contrast|pale|faint|light|dark|readab/i,
};

const SYSTEM = `You are the artwork proofing agent for a custom sticker shop. A customer uploaded
artwork for a die-cut sticker. Measurements have already decided whether it can print and listed
any issues. You get those facts and an image of the proof over a grey checkerboard (checkerboard =
transparent). Write the customer_note:
- No issues: one short, warm line saying the artwork is ready to print.
- Issues: address every listed issue in plain words, what is wrong and exactly how to fix it:
  low_resolution: send a larger file, at least 300 dpi at the ordered size.
  background_not_removed: remove the background and save as a PNG with transparency.
  text_near_edge: move text and detail inward, at least 1/8 inch from the cut line.
  upscaled_blurry: the file looks enlarged from a small image; send the original or a vector file.
  low_contrast: the text is too pale to read; darken it or add an outline.
  Keep it friendly and brief. Do not mention numbers or terms the customer won't know.
extra_concerns: anything else you see in the proof that a human proofer should glance at (at most 3,
usually none). These never block the order.
Output JSON: {"customer_note": "...", "extra_concerns": [...]}.`;

export type ArtworkCase = { path: string; widthIn: number; heightIn: number; product: string };
export type ArtworkResult = AgentResult<ArtworkOutput> & {
  verdict: 'approve' | 'needs_changes';
  issues: Issue[];
  facts: ArtworkFacts;
  // Issues the customer note failed to explain. A note that leaves one out is a
  // failed run: the customer would fix the wrong thing and upload again.
  noteMissing?: Issue[];
  noteContradicts?: boolean;
};

export async function checkArtwork(model: string, art: ArtworkCase, limits: ArtworkLimits): Promise<ArtworkResult> {
  const facts = measureArtwork(art.path, art.widthIn, art.heightIn, limits);
  const issues = measuredIssues(facts) as Issue[];
  const verdict = issues.length ? 'needs_changes' : 'approve';
  const r = await runAgent({
    model,
    system: SYSTEM,
    user: `Order: ${art.product.replace(/_/g, ' ')}, ${art.widthIn} x ${art.heightIn} in.\nMeasured facts: ${JSON.stringify(facts)}\nIssues: ${issues.length ? issues.join(', ') : 'none - ready to print'}\nThe proof image is attached.`,
    images: [proofPreview(art.path)],
    tools: [],
    schema: ArtworkOutput,
    maxSteps: 3,
    // Thinking was 4x slower here and once used its whole budget with no answer.
    think: false,
  });
  if (!r.ok) return { ...r, verdict, issues, facts };
  const note = (r.output as ArtworkOutput).customer_note;
  const noteMissing = issues.filter((i) => !NOTE_COVERS[i].test(note));
  if (noteMissing.length) {
    return { ...r, ok: false, output: { error: `Customer note leaves out: ${noteMissing.join(', ')}. Note: ${note.slice(0, 200)}` }, verdict, issues, facts, noteMissing };
  }
  // A rejected file's note must not tell the customer it is ready: they'd stop reading there.
  if (verdict === 'needs_changes' && /\b(is|it's|looks) ready (to|for) print/i.test(note)) {
    return { ...r, ok: false, output: { error: `Customer note says ready to print on a rejected file. Note: ${note.slice(0, 200)}` }, verdict, issues, facts, noteContradicts: true };
  }
  return { ...r, verdict, issues, facts };
}
