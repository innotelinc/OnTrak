import { describe, expect, it } from 'vitest';
import { curateModels, parseCuratedModels } from './openai-like';

const model = (name: string, maxTokenAllowed = 8000) => ({
  name,
  label: `label:${name}`,
  provider: 'OpenAILike',
  maxTokenAllowed,
});

describe('OPENAI_LIKE_API_MODELS', () => {
  describe('parseCuratedModels', () => {
    it('is empty when the deployment curated nothing', () => {
      expect(parseCuratedModels(undefined)).toEqual([]);
      expect(parseCuratedModels('')).toEqual([]);
      expect(parseCuratedModels('   ')).toEqual([]);
    });

    it('reads upstream’s `path:limit;path:limit` format', () => {
      expect(parseCuratedModels('auto/coding:200000;auto/best-fast:1000')).toEqual([
        { name: 'auto/coding', maxTokenAllowed: 200000 },
        { name: 'auto/best-fast', maxTokenAllowed: 1000 },
      ]);
    });

    it('defaults the limit the way upstream does when it is absent', () => {
      expect(parseCuratedModels('auto/coding')).toEqual([{ name: 'auto/coding', maxTokenAllowed: 8000 }]);
    });

    it('keeps a colon that belongs to the id, not to the limit', () => {
      expect(parseCuratedModels('vendor:tag')).toEqual([{ name: 'vendor:tag', maxTokenAllowed: 8000 }]);
      expect(parseCuratedModels('vendor:tag:4096')).toEqual([{ name: 'vendor:tag', maxTokenAllowed: 4096 }]);
    });
  });

  describe('curateModels', () => {
    it('leaves the catalogue alone when nothing is curated', () => {
      const discovered = [model('a'), model('b')];

      expect(curateModels(discovered, [], 'OpenAILike')).toBe(discovered);
    });

    it('narrows the catalogue to the curated ids, in the curated order', () => {
      const discovered = [model('a'), model('b'), model('c'), model('d')];
      const curated = parseCuratedModels('d;b');

      expect(curateModels(discovered, curated, 'OpenAILike').map((m) => m.name)).toEqual(['d', 'b']);
    });

    it('keeps the catalogue’s label and context length for a model it lists', () => {
      const discovered = [model('auto/coding', 1048576)];
      const [result] = curateModels(discovered, parseCuratedModels('auto/coding:4096'), 'OpenAILike');

      expect(result.label).toBe('label:auto/coding');
      expect(result.maxTokenAllowed).toBe(1048576);
      expect(result.provider).toBe('OpenAILike');
    });

    it('does not cap a declared limit at the 8,000-token placeholder every id is listed with', () => {
      // An OpenAI-style `/models` answer carries no context length, so every discovered
      // id arrives at 8,000. A curated entry is the one real number here, and taking the
      // catalogue's placeholder over it refused the first turn on that model.
      const discovered = [model('auto/coding')];
      const [result] = curateModels(discovered, parseCuratedModels('auto/coding:200000'), 'OpenAILike');

      expect(result.maxTokenAllowed).toBe(200000);
    });

    it('still offers a curated id the catalogue does not list, with its declared limit', () => {
      const [result] = curateModels([], parseCuratedModels('auto/coding:200000'), 'OpenAILike');

      expect(result).toMatchObject({ name: 'auto/coding', label: 'auto/coding', maxTokenAllowed: 200000 });
    });
  });
});
