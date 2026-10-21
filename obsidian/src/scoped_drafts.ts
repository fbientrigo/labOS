export interface DraftImage { title: string; path: string; kind: string }

interface Draft {
  fields: Map<string, string>;
  images: DraftImage[];
}

/** In-memory drafts are isolated by work context and form (note vs measurement). */
export class ScopedDrafts {
  private readonly values = new Map<string, Draft>();

  private getDraft(scope: string): Draft {
    let draft = this.values.get(scope);
    if (!draft) {
      draft = { fields: new Map(), images: [] };
      this.values.set(scope, draft);
    }
    return draft;
  }

  field(scope: string, name: string): string | undefined {
    return this.values.get(scope)?.fields.get(name);
  }

  setField(scope: string, name: string, value: string): void {
    this.getDraft(scope).fields.set(name, value);
  }

  clearField(scope: string, name: string): void {
    const draft = this.values.get(scope);
    draft?.fields.delete(name);
    this.removeIfEmpty(scope, draft);
  }

  clearFieldIfValue(scope: string, name: string, value: string): void {
    if (this.field(scope, name) === value) this.clearField(scope, name);
  }

  images(scope: string): readonly DraftImage[] {
    return this.values.get(scope)?.images ?? [];
  }

  addImage(scope: string, image: DraftImage): void {
    this.getDraft(scope).images.push(image);
  }

  clearImages(scope: string): void {
    const draft = this.values.get(scope);
    if (draft) draft.images = [];
    this.removeIfEmpty(scope, draft);
  }

  removeImages(scope: string, images: readonly DraftImage[]): void {
    const draft = this.values.get(scope);
    if (!draft || images.length === 0) return;
    const consumed = new Set(images);
    draft.images = draft.images.filter((image) => !consumed.has(image));
    this.removeIfEmpty(scope, draft);
  }

  clear(scope: string): void {
    this.values.delete(scope);
  }

  private removeIfEmpty(scope: string, draft?: Draft): void {
    if (draft && draft.fields.size === 0 && draft.images.length === 0) this.values.delete(scope);
  }
}
