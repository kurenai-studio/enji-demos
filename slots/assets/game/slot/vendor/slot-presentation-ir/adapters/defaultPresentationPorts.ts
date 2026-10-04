import { serialize, deserialize, roundTrip } from '../serde';
import { validateSchema } from '../validator';
import type { IPresentationSerde, IPresentationValidator } from '../ports/presentation';

/** 默认 PresentationState 校验器（wrap `validateSchema`） */
export const defaultPresentationValidator: IPresentationValidator = {
  validate: validateSchema,
};

/** 默认 PresentationState JSON serde（wrap `serialize` / `deserialize`） */
export const defaultPresentationSerde: IPresentationSerde = {
  serialize,
  deserialize,
  roundTrip,
};
