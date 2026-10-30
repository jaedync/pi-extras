/**
 * The film's entry: the scene modules by name. A storyboard shot names its
 * scene; one scene module can draw many shots with different parameters.
 */
import { mountFilm } from "./kit/film.ts";
import claim from "./scenes/claim.ts";
import end from "./scenes/end.ts";
import footage from "./scenes/footage.ts";
import product from "./scenes/product.ts";

mountFilm({ claim, product, footage, end });
