export function calculatePackaging(unitCount, unitsPerBox, boxesPerPallet) {
  const units = Math.max(0, Number(unitCount) || 0);
  const boxSize = Math.max(1, Number(unitsPerBox) || 1);
  const palletSize = Math.max(1, Number(boxesPerPallet) || 1);
  const unitsPerPallet = boxSize * palletSize;
  const fullPallets = Math.floor(units / unitsPerPallet);
  const afterPallets = units % unitsPerPallet;
  const fullBoxes = Math.floor(afterPallets / boxSize);
  const looseUnits = afterPallets % boxSize;

  return {
    units,
    unitsPerBox: boxSize,
    boxesPerPallet: palletSize,
    unitsPerPallet,
    fullPallets,
    fullBoxes,
    looseUnits,
    boxEquivalent: Number((units / boxSize).toFixed(3)),
    palletEquivalent: Number((units / unitsPerPallet).toFixed(3))
  };
}

