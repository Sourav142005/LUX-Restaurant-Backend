const mongoose = require("mongoose");
const { GoogleGenAI } = require("@google/genai");
const Menu = require("../models/Menu");
require("../models/Category"); // Ensure Category model is registered for populate

// Cache menu in memory for fast recommendations (refreshed every minute)
let cachedMenu = null;
let lastMenuFetch = 0;
const CACHE_TTL_MS = 60 * 1000;

async function getLiveMenu(forceRefresh = false) {
  // If MongoDB is not connected, live menu is unavailable
  if (!mongoose.connection || mongoose.connection.readyState !== 1) {
    cachedMenu = null;
    return null;
  }

  const now = Date.now();
  if (!forceRefresh && cachedMenu && now - lastMenuFetch < CACHE_TTL_MS) {
    return cachedMenu;
  }

  try {
    const dishes = await Menu.find({ isAvailable: true }).populate("category").lean();
    if (!dishes || dishes.length === 0) {
      cachedMenu = [];
      lastMenuFetch = now;
      return cachedMenu;
    }

    cachedMenu = dishes.map((d) => ({
      _id: d._id ? d._id.toString() : String(d._id),
      name: d.name,
      description: d.description || "",
      price: Number(d.price) || 0,
      categoryName: d.category?.name || "General",
      isVeg: Boolean(d.isVeg),
      isAvailable: Boolean(d.isAvailable),
      preparationTime: Number(d.preparationTime) || 15,
      image: d.image || "",
      model3D: d.model3D || ""
    }));
    lastMenuFetch = now;
    return cachedMenu;
  } catch (err) {
    console.warn("[LUX AI] Database menu query unavailable:", err.message);
    cachedMenu = null;
    return null;
  }
}

// Convert common words to numbers
const WORD_TO_NUM = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  single: 1,
  double: 2,
  couple: 2,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10
};

// Match dish query against live database records with unambiguous matching
function matchDishQuery(dishQuery, dishes) {
  const q = dishQuery.toLowerCase().replace(/['".,!]/g, "").trim();
  if (!q) return { status: "EMPTY" };

  const singularQ = q.replace(/ies$/, "y").replace(/es$/, "").replace(/s$/, "");

  // 1. Direct exact match (case-insensitive)
  const exact = dishes.find((d) => {
    const dName = d.name.toLowerCase().trim();
    return dName === q || dName === singularQ;
  });
  if (exact) return { status: "MATCH", dish: exact };

  // 2. Multi-word phrase or token match
  const matches = [];
  for (const dish of dishes) {
    const dName = dish.name.toLowerCase();
    if (dName === q || dName === singularQ) {
      matches.push(dish);
    } else if (
      q.length >= 3 &&
      (dName.includes(q) ||
        q.includes(dName) ||
        dName.includes(singularQ) ||
        singularQ.includes(dName))
    ) {
      matches.push(dish);
    }
  }

  // 3. Unambiguous aliases if only one dish qualifies
  if (matches.length === 0) {
    if (/\b(?:pizza|pizzas)\b/i.test(q)) {
      const pizzas = dishes.filter(
        (d) => /pizza/i.test(d.name) || /pizza/i.test(d.categoryName)
      );
      if (pizzas.length === 1) matches.push(pizzas[0]);
      else if (pizzas.length > 1) {
        return { status: "AMBIGUOUS", candidates: pizzas, query: dishQuery };
      }
    }
    if (/\b(?:cappuccino|cappuccinos|coffee|coffees|espresso)\b/i.test(q)) {
      const coffees = dishes.filter((d) =>
        /cappuccino|coffee|espresso/i.test(d.name)
      );
      if (coffees.length === 1) matches.push(coffees[0]);
      else if (coffees.length > 1) {
        return { status: "AMBIGUOUS", candidates: coffees, query: dishQuery };
      }
    }
    if (/\b(?:pastry|pastries|chocolate pastry|cake|cakes)\b/i.test(q)) {
      const pastries = dishes.filter((d) => /pastry|cake/i.test(d.name));
      if (pastries.length === 1) matches.push(pastries[0]);
      else if (pastries.length > 1) {
        return { status: "AMBIGUOUS", candidates: pastries, query: dishQuery };
      }
    }
    if (/\b(?:pepsi|pepsis|cola|colas|cold drink|cold drinks|soft drink|soft drinks)\b/i.test(q)) {
      const pepsis = dishes.filter((d) => /pepsi|cola|soda/i.test(d.name));
      if (pepsis.length === 1) matches.push(pepsis[0]);
      else if (pepsis.length > 1) {
        return { status: "AMBIGUOUS", candidates: pepsis, query: dishQuery };
      }
    }
    if (/\b(?:soup|soups|tomato soup)\b/i.test(q)) {
      const soups = dishes.filter(
        (d) => /soup/i.test(d.name) || /soups?/i.test(d.categoryName)
      );
      if (soups.length === 1) matches.push(soups[0]);
      else if (soups.length > 1) {
        return { status: "AMBIGUOUS", candidates: soups, query: dishQuery };
      }
    }
  }

  // Deduplicate matches by _id
  const uniqueMatches = [...new Map(matches.map((m) => [m._id, m])).values()];

  if (uniqueMatches.length === 1) {
    return { status: "MATCH", dish: uniqueMatches[0] };
  }

  if (uniqueMatches.length > 1) {
    // If one dish is an exact full name match (e.g. "tomato soup" === "tomato soup")
    const exactName = uniqueMatches.find(
      (d) => d.name.toLowerCase().trim() === q || d.name.toLowerCase().trim() === singularQ
    );
    if (exactName) {
      return { status: "MATCH", dish: exactName };
    }
    return { status: "AMBIGUOUS", candidates: uniqueMatches, query: dishQuery };
  }

  return { status: "UNRECOGNIZED", query: dishQuery };
}

// Timeout wrapper for external API calls
function withTimeout(promise, ms = 20000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`API request timed out after ${ms}ms`)), ms)
    )
  ]);
}

// Deterministic Intelligence Engine & Order Parser
function generateDeterministicReply(userMessage, dishes, context = {}) {
  // Safe handling if menu is empty or null
  if (!dishes || dishes.length === 0) {
    return {
      reply: "Our kitchen currently has no menu items available. Please check back with us soon!",
      action: "NONE",
      proposedItems: [],
      itemsToCart: [],
      recommendedDishes: []
    };
  }

  const text = (userMessage || "").trim().toLowerCase();
  const pendingOrder = context.pendingOrder || null;

  // 1. CONFIRMATION OF PENDING ORDER (uses fresh MongoDB dishes provided in dishes argument)
  const isAffirmative =
    /\b(?:yes|yeah|yep|sure|confirm|proceed|ok|okay|add it|add them|do it|positive|please do|go ahead|correct|sounds good|yes please)\b/i.test(
      text
    ) && !/\b(?:no|not|don't|dont|cancel)\b/i.test(text);

  if (
    pendingOrder &&
    Array.isArray(pendingOrder) &&
    pendingOrder.length > 0 &&
    isAffirmative
  ) {
    const validatedItems = [];
    const changesList = [];
    let hasChanges = false;

    for (const item of pendingOrder) {
      const match = dishes.find(
        (d) =>
          (item._id && String(d._id) === String(item._id)) ||
          d.name.toLowerCase() === (item.name || "").toLowerCase()
      );

      if (!match || !match.isAvailable) {
        hasChanges = true;
        changesList.push(
          `• **${item.name || "Item"}** is currently out of stock or no longer available.`
        );
      } else if (match.price !== item.price) {
        hasChanges = true;
        changesList.push(
          `• **${match.name}** price has changed from ₹${item.price} to ₹${match.price}.`
        );
        validatedItems.push({
          _id: match._id,
          name: match.name,
          price: match.price,
          quantity: Math.max(1, Math.min(20, parseInt(item.quantity, 10) || 1)),
          image: match.image || "",
          model3D: match.model3D || "",
          isVeg: Boolean(match.isVeg)
        });
      } else {
        validatedItems.push({
          _id: match._id,
          name: match.name,
          price: match.price,
          quantity: Math.max(1, Math.min(20, parseInt(item.quantity, 10) || 1)),
          image: match.image || "",
          model3D: match.model3D || "",
          isVeg: Boolean(match.isVeg)
        });
      }
    }

    // If an item is missing or price changed, ask customer to review a refreshed proposal
    if (hasChanges) {
      if (validatedItems.length > 0) {
        const refreshedTotal = validatedItems.reduce(
          (sum, i) => sum + i.price * i.quantity,
          0
        );
        return {
          reply: `Some menu details have changed since your initial request:\n\n${changesList.join("\n")}\n\nI have updated your proposal with the latest menu details (Total: ₹${refreshedTotal.toLocaleString("en-IN")}). Would you like to confirm this updated order?`,
          action: "PROPOSE_CART_ADD",
          proposedItems: validatedItems,
          itemsToCart: [],
          total: refreshedTotal,
          hasPriceChanges: true,
          recommendedDishes: validatedItems
        };
      } else {
        return {
          reply: `I apologize, but the items in your order are currently unavailable:\n\n${changesList.join("\n")}\n\nYour cart remains unchanged. Would you like to explore what is currently available on our menu?`,
          action: "NONE",
          proposedItems: [],
          itemsToCart: [],
          recommendedDishes: dishes.slice(0, 3)
        };
      }
    }

    // All items match fresh database records with identical prices!
    const total = validatedItems.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );
    const itemListStr = validatedItems
      .map((i) => `${i.quantity}x ${i.name}`)
      .join(", ");

    return {
      reply: `Confirmed! I have added ${itemListStr} (Total: ₹${total.toLocaleString("en-IN")}) directly to your cart. Please review your cart whenever you are ready to place your order with our restaurant!`,
      action: "CONFIRM_CART_ADD",
      proposedItems: [],
      itemsToCart: validatedItems,
      total,
      recommendedDishes: []
    };
  }

  // 2. CANCELLATION OF PENDING ORDER
  const isNegative =
    /\b(?:no|cancel|nevermind|don't add|dont add|stop|abort|no thanks|nah|nope|clear|forget it|leave it)\b/i.test(
      text
    );

  if (pendingOrder && isNegative) {
    return {
      reply: "No problem! I have cancelled that proposal. Your cart remains unchanged. How else can I assist you with dining today?",
      action: "CANCEL_CART_ADD",
      proposedItems: [],
      itemsToCart: [],
      recommendedDishes: []
    };
  }

  // 3. CONVERSATIONAL ORDER REQUEST ("add 1 pizza and 2 cappuccinos", "make it 2 pizzas", "one pizza instead")
  const isOrderIntent =
    /(?:\badd\b|\border\b|\bcart\b|\bbuy\b|\bwant to get\b|\bget me\b|\bhave\b|\bi'd like\b|\bi want\b|\bgive me\b|\bcan i get\b|\bcan i have\b|\bmake it\b|\bmake that\b|\bchange(?:\s+it|\s+order)?\s+to\b|\bchange to\b|\bswitch(?:\s+to)?\b|\binstead\b)/i.test(
      text
    ) &&
    !/(?:\bwhat\b|\bhow much\b|\bhow long\b|\bprice\b|\btell me\b|\bsuggest\b|\brecommend\b|\bwhat is\b)/i.test(
      text
    );

  if (isOrderIntent) {
    const proposedItems = [];
    const unrecognized = [];
    const ambiguous = [];

    // Split compound phrases
    const segments = text
      .replace(
        /^.*?(?:add|order|get me|i want|i would like|i'd like|give me|can i get|can i have|make it|make that|change(?:\s+it|\s+order)?\s+to|change to|switch(?:\s+to)?|instead)\s+/i,
        ""
      )
      .replace(/\s+(?:to|into|in)\s+(?:my\s+)?cart.*$/i, "")
      .replace(/\s+instead(?:\s+of.*)?$/i, "")
      .split(/\s*(?:,\s*|\s+and\s+|\s*\+\s*)\s*/i);

    for (const segment of segments) {
      if (!segment.trim()) continue;

      let quantity = 1;
      let dishQuery = segment.replace(/\s+instead(?:\s+of.*)?$/i, "").trim();

      const numMatch = dishQuery.match(
        /^(?:(\d+)|(a|an|one|two|three|four|five|six|seven|eight|nine|ten|single|double|couple))\s+(.+)$/i
      );

      if (numMatch) {
        const rawNum = (numMatch[1] || numMatch[2] || "").toLowerCase();
        quantity = WORD_TO_NUM[rawNum] || parseInt(rawNum, 10) || 1;
        dishQuery = numMatch[3].trim();
      }

      const trailingNumMatch = dishQuery.match(/^(.+?)\s+(\d+)$/);
      if (trailingNumMatch) {
        dishQuery = trailingNumMatch[1].trim();
        quantity = parseInt(trailingNumMatch[2], 10) || quantity;
      }

      const matchResult = matchDishQuery(dishQuery, dishes);

      if (matchResult.status === "MATCH" && matchResult.dish?.isAvailable) {
        const matchedDish = matchResult.dish;
        const existing = proposedItems.find((p) => p._id === matchedDish._id);
        if (existing) {
          existing.quantity = Math.min(20, existing.quantity + quantity);
        } else {
          proposedItems.push({
            _id: matchedDish._id,
            name: matchedDish.name,
            price: matchedDish.price,
            quantity: Math.max(1, Math.min(20, quantity)),
            image: matchedDish.image || "",
            model3D: matchedDish.model3D || "",
            isVeg: Boolean(matchedDish.isVeg)
          });
        }
      } else if (matchResult.status === "AMBIGUOUS") {
        ambiguous.push(matchResult);
      } else if (matchResult.status === "UNRECOGNIZED") {
        unrecognized.push(dishQuery);
      }
    }

    // If any item was ambiguous, ask the guest to clarify instead of assuming
    if (ambiguous.length > 0) {
      const clarifyLines = ambiguous
        .map(
          (a) =>
            `• You mentioned "${a.query}". Did you mean ${a.candidates
              .map((c) => `**${c.name}** (₹${c.price})`)
              .join(" or ")}?`
        )
        .join("\n");

      return {
        reply: `I want to make sure your order is exact. Please clarify:\n\n${clarifyLines}\n\nOnce you let me know, I'll prepare your order proposal right away!`,
        action: "NONE",
        proposedItems: [],
        itemsToCart: [],
        isClarification: true,
        recommendedDishes: ambiguous.flatMap((a) => a.candidates)
      };
    }

    // If valid items are found (with or without unrecognized items)
    if (proposedItems.length > 0) {
      const total = proposedItems.reduce(
        (sum, item) => sum + item.price * item.quantity,
        0
      );

      let replyMsg = `I have prepared an order proposal for the items available on our menu:\n`;
      replyMsg += proposedItems
        .map(
          (i) =>
            `• **${i.quantity}x ${i.name}** — ₹${(i.price * i.quantity).toLocaleString("en-IN")}`
        )
        .join("\n");
      replyMsg += `\n\n**Proposal Total: ₹${total.toLocaleString("en-IN")}**`;

      if (unrecognized.length > 0) {
        const missingStr = unrecognized.map((u) => `"${u}"`).join(", ");
        replyMsg += `\n\n⚠️ **Note on unavailable items:** We could not find ${missingStr} on our current menu, so ${
          unrecognized.length > 1 ? "they have" : "it has"
        } **not** been added to this proposal.`;
      }

      replyMsg += `\n\nWould you like me to add ${proposedItems
        .map((i) => `${i.quantity}x ${i.name}`)
        .join(", ")} to your cart? Please confirm with "Yes".`;

      return {
        reply: replyMsg,
        action: "PROPOSE_CART_ADD",
        proposedItems,
        itemsToCart: [],
        unrecognized,
        total,
        recommendedDishes: proposedItems
      };
    } else if (unrecognized.length > 0) {
      const missingStr = unrecognized.map((u) => `"${u}"`).join(", ");
      const menuList = dishes.map((d) => `${d.name} (₹${d.price})`).join(", ");
      return {
        reply: `I could not find ${missingStr} on our current menu. Our kitchen currently serves: ${menuList}.\n\nWould you like to order any of these?`,
        action: "NONE",
        proposedItems: [],
        itemsToCart: [],
        recommendedDishes: dishes
      };
    }
  }

  // 4. BUDGET INQUIRIES ("under 300", "below ₹200", "budget of 150")
  const budgetMatch = text.match(
    /(?:under|below|less than|within|budget(?:\s+of)?)\s*(?:rs\.?|inr|₹)?\s*(\d+)/i
  );

  if (budgetMatch) {
    const maxBudget = parseInt(budgetMatch[1], 10);
    const affordable = dishes.filter((d) => d.price <= maxBudget);

    if (affordable.length === 0) {
      const minDish = dishes.reduce(
        (prev, curr) => (curr.price < prev.price ? curr : prev),
        dishes[0]
      );
      return {
        reply: `Our most accessible dish starts at ₹${minDish.price} (${minDish.name}). We do not currently have dishes strictly under ₹${maxBudget}.`,
        action: "NONE",
        proposedItems: [],
        itemsToCart: [],
        recommendedDishes: [minDish]
      };
    }

    const dishList = affordable
      .map(
        (d) =>
          `• **${d.name}** — ₹${d.price} (${d.categoryName}${
            d.preparationTime ? `, ~${d.preparationTime} mins` : ""
          })`
      )
      .join("\n");

    // Dynamic combo suggestion derived purely from actual database items
    let comboSuggestion = "";
    const foodItem = dishes.find(
      (d) =>
        !/beverage|drink/i.test(d.categoryName) &&
        d.price < maxBudget
    );
    const drinkItem = dishes.find(
      (d) =>
        /beverage|drink/i.test(d.categoryName) &&
        d._id !== foodItem?._id
    );

    if (foodItem && drinkItem && foodItem.price + drinkItem.price <= maxBudget) {
      const comboTotal = foodItem.price + drinkItem.price;
      comboSuggestion = `\n\n💡 **Chef's Combo Suggestion:** You can pair **${foodItem.name}** (₹${foodItem.price}) + **${drinkItem.name}** (₹${drinkItem.price}) for a complete meal at **₹${comboTotal}**!`;
    }

    return {
      reply: `Here are our exquisite options within your budget of ₹${maxBudget}:\n\n${dishList}${comboSuggestion}\n\nWould you like me to add any of these to your cart?`,
      action: "NONE",
      proposedItems: [],
      itemsToCart: [],
      recommendedDishes: affordable
    };
  }

  // 5. VEGETARIAN / DIETARY INQUIRIES
  const allVeg = dishes.length > 0 && dishes.every((d) => d.isVeg);

  if (
    /veg|vegetarian|pure veg|plant|green/i.test(text) &&
    !/non-veg/i.test(text)
  ) {
    const vegDishes = dishes.filter((d) => d.isVeg);
    const dishList = vegDishes
      .map(
        (d) =>
          `• **${d.name}** — ₹${d.price} (${d.categoryName})${
            d.description ? ` — *${d.description}*` : ""
          }`
      )
      .join("\n");

    const intro = allVeg
      ? "All our currently available menu offerings are 100% vegetarian prepared with premium ingredients:"
      : "Here are our exquisite vegetarian selections from today's menu:";

    return {
      reply: `${intro}\n\n${dishList}\n\nJust tell me what you'd like to taste or say "Add [item name]" to start ordering!`,
      action: "NONE",
      proposedItems: [],
      itemsToCart: [],
      recommendedDishes: vegDishes
    };
  }

  if (/non-veg|chicken|meat|fish|egg/i.test(text)) {
    const nonVeg = dishes.filter((d) => !d.isVeg);
    if (nonVeg.length === 0) {
      const samples = dishes
        .slice(0, 2)
        .map((d) => `**${d.name}** (₹${d.price})`)
        .join(" and ");
      return {
        reply: `Currently, our kitchen features an exclusively vegetarian menu. Our guests highly recommend ${
          samples || "our signature dishes"
        }!`,
        action: "NONE",
        proposedItems: [],
        itemsToCart: [],
        recommendedDishes: dishes.slice(0, 2)
      };
    } else {
      const nonVegList = nonVeg
        .map(
          (d) =>
            `• **${d.name}** — ₹${d.price} (${d.categoryName})${
              d.description ? ` — *${d.description}*` : ""
            }`
        )
        .join("\n");
      return {
        reply: `Here are our non-vegetarian offerings:\n\n${nonVegList}`,
        action: "NONE",
        proposedItems: [],
        itemsToCart: [],
        recommendedDishes: nonVeg
      };
    }
  }

  // 6. SPECIFIC DISH DETAILS ("price of cappuccino", "tell me about pizza", "preparation time")
  const specificDishMatch = matchDishQuery(text, dishes);
  if (
    specificDishMatch.status === "MATCH" &&
    /price|cost|prep|time|how long|about|detail|tell me|ingredients|what is/i.test(
      text
    )
  ) {
    const d = specificDishMatch.dish;
    const arNotice = d.model3D
      ? "Interactive 3D / Augmented Reality view is available on the menu!"
      : "";
    const desc = d.description ? `\n• **Description:** ${d.description}` : "";
    const prep = d.preparationTime
      ? `\n• **Preparation Time:** ~${d.preparationTime} minutes`
      : "";

    return {
      reply: `**${d.name}**\n• **Price:** ₹${d.price}\n• **Category:** ${
        d.categoryName
      } (${d.isVeg ? "Vegetarian" : "Non-Veg"})${prep}${desc}${
        arNotice ? `\n• **Experience:** ${arNotice}` : ""
      }\n\nWould you like me to add this to your cart? Just say *"Add ${d.name}"*.`,
      action: "NONE",
      proposedItems: [],
      itemsToCart: [],
      recommendedDishes: [d]
    };
  }

  // 7. PAIRING & COMBO SUGGESTIONS (dynamically calculated from available dishes)
  if (/pair|goes with|complement|combo|side|along with/i.test(text)) {
    const matchedDish = dishes.find((d) =>
      text.includes(d.name.toLowerCase())
    );
    const baseDish =
      matchedDish ||
      dishes.find((d) => /pizza|soup|main/i.test(d.categoryName)) ||
      dishes[0];

    const beverage = dishes.find(
      (d) =>
        (/beverage|drink/i.test(d.categoryName) ||
          /pepsi|coffee|cappuccino/i.test(d.name)) &&
        d._id !== baseDish?._id
    );

    const dessert = dishes.find(
      (d) =>
        (/dessert|sweet/i.test(d.categoryName) ||
          /pastry|cake/i.test(d.name)) &&
        d._id !== baseDish?._id
    );

    if (baseDish && beverage) {
      const comboPrice = baseDish.price + beverage.price;
      let replyText = `For our **${baseDish.name}** (₹${baseDish.price}), we highly recommend pairing it with a refreshing **${beverage.name}** (₹${beverage.price})`;
      if (dessert) {
        replyText += `, followed by **${dessert.name}** (₹${dessert.price}) for dessert`;
      }
      replyText += `! (Pairing Total: ₹${comboPrice})\n\nShall I add this combination to your order proposal?`;

      return {
        reply: replyText,
        action: "NONE",
        proposedItems: [],
        itemsToCart: [],
        recommendedDishes: [baseDish, beverage, dessert].filter(Boolean)
      };
    }
  }

  // 8. LIGHT MEAL / LUNCH RECOMMENDATIONS
  if (/light|lunch|snack|quick|healthy|appetizer/i.test(text)) {
    const lightOptions = dishes
      .filter(
        (d) =>
          /soup|beverage|salad|appetizer/i.test(d.categoryName) ||
          d.preparationTime <= 10 ||
          d.price <= 150
      )
      .slice(0, 3);
    const optionsToUse =
      lightOptions.length > 0 ? lightOptions : dishes.slice(0, 2);

    const list = optionsToUse
      .map(
        (d, idx) =>
          `${idx + 1}. **${d.name}** (₹${d.price})${
            d.preparationTime
              ? ` — prepared in ~${d.preparationTime} mins`
              : ""
          }`
      )
      .join("\n");

    return {
      reply: `For a lighter meal or refreshment, we recommend:\n\n${list}\n\nWould you like me to add any of these to your cart?`,
      action: "NONE",
      proposedItems: [],
      itemsToCart: [],
      recommendedDishes: optionsToUse
    };
  }

  // 9. DESSERT / SWEET INQUIRIES
  if (/dessert|sweet|pastry|cake|chocolate/i.test(text)) {
    const desserts = dishes.filter(
      (d) =>
        /dessert/i.test(d.categoryName) ||
        /pastry|cake|sweet|chocolate|ice/i.test(d.name)
    );

    if (desserts.length > 0) {
      const list = desserts
        .map(
          (d) =>
            `• **${d.name}** — ₹${d.price}${
              d.description ? ` (${d.description})` : ""
            }`
        )
        .join("\n");

      return {
        reply: `Here are our delectable dessert selections:\n\n${list}\n\nWould you like one added to your cart?`,
        action: "NONE",
        proposedItems: [],
        itemsToCart: [],
        recommendedDishes: desserts
      };
    }

    return {
      reply:
        "We currently do not have dessert items available on today's menu. Can I assist you with another selection?",
      action: "NONE",
      proposedItems: [],
      itemsToCart: [],
      recommendedDishes: dishes.slice(0, 2)
    };
  }

  // 10. DRINKS / BEVERAGES
  if (/drink|beverage|coffee|cold|pepsi/i.test(text)) {
    const drinks = dishes.filter(
      (d) =>
        /beverage|drink/i.test(d.categoryName) ||
        /pepsi|coffee|cappuccino|tea|cola|soda/i.test(d.name)
    );

    if (drinks.length > 0) {
      const list = drinks
        .map(
          (d) =>
            `• **${d.name}** — ₹${d.price}${
              d.preparationTime ? ` (~${d.preparationTime} mins)` : ""
            }`
        )
        .join("\n");

      return {
        reply: `Here are our handcrafted beverages:\n\n${list}\n\nSay *"Add [drink name]"* anytime to place it in your cart!`,
        action: "NONE",
        proposedItems: [],
        itemsToCart: [],
        recommendedDishes: drinks
      };
    }
  }

  // 11. GENERAL / GREETING FALLBACK
  return {
    reply: `Welcome to **LUX**! I'm **Luci**, your personal dining concierge and hands-free voice assistant.\n\nHere are some things you can ask me:\n• *"What can I eat under ₹300?"*\n• *"Recommend vegetarian dishes"*\n• *"What goes well with our menu items?"*\n• *"What is the price of ${
      dishes[0]?.name || "a dish"
    }?"*\n• *"Add one ${
      dishes[0]?.name || "dish"
    } to my cart"*\n\nHow may I help you dine today?`,
    action: "NONE",
    proposedItems: [],
    itemsToCart: [],
    recommendedDishes: dishes.slice(0, 3)
  };
}

// Main AI entry point
async function askAstra(message, context = {}) {
  const text = (message || "").trim().toLowerCase();

  // Detect whether customer is explicitly confirming a pending order
  const isAffirmative =
    /\b(?:yes|yeah|yep|sure|confirm|proceed|ok|okay|add it|add them|do it|positive|please do|go ahead|correct|sounds good|yes please)\b/i.test(
      text
    ) && !/\b(?:no|not|don't|dont|cancel)\b/i.test(text);

  const pendingOrder = context.pendingOrder;
  const isConfirming =
    pendingOrder &&
    Array.isArray(pendingOrder) &&
    pendingOrder.length > 0 &&
    isAffirmative;

  // Fresh menu records are fetched on order confirmation to prevent stale prices/items
  const dishes = await getLiveMenu(isConfirming);

  // 1. If MongoDB is unavailable, inform the user safely without exposing internal details
  if (dishes === null) {
    return {
      reply:
        "I apologize, but Luci cannot access the current LUX menu right now. Please try again shortly.",
      action: "NONE",
      proposedItems: [],
      itemsToCart: [],
      recommendedDishes: [],
      provider: "deterministic"
    };
  }

  // 2. If the database is connected but no dishes are available, do not invent dishes
  if (dishes.length === 0) {
    return {
      reply:
        "Our kitchen currently has no menu items available. Please check back with us soon!",
      action: "NONE",
      proposedItems: [],
      itemsToCart: [],
      recommendedDishes: [],
      provider: "deterministic"
    };
  }

  // 3. Run deterministic intent extraction & menu validation against live dishes
  const structuredPass = generateDeterministicReply(message, dishes, context);

  // If a clarification is needed or prices/availability changed,
  // return the deterministic response directly so exact details are not bypassed
  if (structuredPass.isClarification || structuredPass.hasPriceChanges) {
    return {
      ...structuredPass,
      provider: "deterministic"
    };
  }

  // 4. Try Gemini LLM if GEMINI_API_KEY is configured
  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey });

      // Build live menu description
      const menuPrompt = dishes
        .map(
          (d) =>
            `- ${d.name}: ₹${d.price}, Category: ${d.categoryName}, Veg: ${
              d.isVeg ? "Yes" : "No"
            }, Prep: ${d.preparationTime} min. Description: ${d.description}`
        )
        .join("\n");

      const allVeg = dishes.every((d) => d.isVeg);

      // System instruction with real live menu context
      let systemPrompt = `You are Luci (Luci by LUX), the personal dining concierge and hands-free voice assistant for the luxury restaurant LUX.
Available live menu:
${menuPrompt}

Rules:
1. ONLY recommend or discuss dishes from the menu above. NEVER invent dishes, prices, ingredients, allergen information, dietary certifications, or preparation times. If the menu lacks specific details, state honestly that our records do not specify it.
2. For questions unrelated to food, dining, or restaurant reservations, politely decline and steer the conversation back toward dining at LUX.
3. When guests ask for dish comparisons, compare flavors, preparation times, categories, and prices based strictly on the live menu.
4. When guests ask about budget, pairing, drinks, or desserts, provide helpful recommendations grounded in the live menu.
5. ${allVeg ? "All items on our current menu are 100% vegetarian." : "Check each item's vegetarian flag from the menu list."}
6. If guest asks about budget or pricing, calculate costs accurately using the exact prices above.
7. Never claim an order has been placed with the restaurant kitchen merely because items were added to the shopping cart. Remind guests that items are in their cart ready for review before checkout.
8. Cart additions require explicit guest confirmation.
9. Keep your tone warm, elegant, charming, concise, and helpful.`;

      // Pass context about detected cart actions
      if (
        structuredPass.action === "PROPOSE_CART_ADD" &&
        structuredPass.proposedItems?.length > 0
      ) {
        const itemSummary = structuredPass.proposedItems
          .map((i) => `${i.quantity}x ${i.name} (₹${i.price * i.quantity})`)
          .join(", ");
        systemPrompt += `\n\nNotice: The guest wants to order: ${itemSummary} (Total: ₹${structuredPass.total}).`;
        if (structuredPass.unrecognized && structuredPass.unrecognized.length > 0) {
          systemPrompt += ` Notice that the following requested items were not found on our menu: ${structuredPass.unrecognized.join(", ")}. Explicitly state to the guest that these items could not be found and have not been added to the proposal.`;
        }
        systemPrompt += ` Provide an elegant order summary with individual prices and total cost, and clearly ask if they would like you to add these items to their cart.`;
      } else if (
        structuredPass.unrecognized &&
        structuredPass.unrecognized.length > 0 &&
        (!structuredPass.proposedItems || structuredPass.proposedItems.length === 0)
      ) {
        systemPrompt += `\n\nNotice: The guest requested items (${structuredPass.unrecognized.join(", ")}) that could not be found on our current menu. Politely state that these items could not be found on our menu, and recommend available dishes from our live menu.`;
      } else if (
        structuredPass.action === "CONFIRM_CART_ADD" &&
        structuredPass.itemsToCart?.length > 0
      ) {
        const itemSummary = structuredPass.itemsToCart
          .map((i) => `${i.quantity}x ${i.name}`)
          .join(", ");
        systemPrompt += `\n\nNotice: The guest confirmed their order of: ${itemSummary}.
Warmly confirm that these items have been added to their cart, and that they can review their cart whenever they are ready to proceed with their order at the restaurant.`;
      } else if (structuredPass.action === "CANCEL_CART_ADD") {
        systemPrompt += `\n\nNotice: The guest cancelled their order proposal.
Politely confirm that the request was cancelled and their cart was unchanged. Ask how else you can assist them.`;
      }

      const response = await withTimeout(
        ai.models.generateContent({
          model: "gemini-3.1-flash-lite",
          contents: message,
          config: {
            systemInstruction: systemPrompt,
            temperature: 0.5
          }
        }),
        20000
      );

      const geminiText = response && response.text ? response.text.trim() : null;

      if (geminiText) {
        return {
          reply: geminiText,
          action: structuredPass.action,
          proposedItems: structuredPass.proposedItems || [],
          itemsToCart: structuredPass.itemsToCart || [],
          recommendedDishes: structuredPass.recommendedDishes || [],
          provider: "gemini"
        };
      }
    } catch (llmError) {
      console.warn(
        `[LUX AI] Gemini notice (${llmError.message || "service notice"}). Using LUX deterministic engine.`
      );
      // Fall through to deterministic response
    }
  }

  // 5. Fallback when Gemini is unavailable, unconfigured, or timed out
  return {
    ...structuredPass,
    provider: "deterministic"
  };
}

module.exports = {
  askAstra,
  getLiveMenu,
  generateDeterministicReply,
  matchDishQuery
};
