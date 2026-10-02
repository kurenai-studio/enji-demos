// Lets Node load the game's TypeScript modules, which import each other without
// file extensions (as Creator expects): node --import ./tools/ts-resolve.mjs tools/bake.mts
import { registerHooks } from 'node:module';

registerHooks({
    resolve(specifier, context, next) {
        try {
            return next(specifier, context);
        } catch (error) {
            if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
            throw error;
        }
    },
});
