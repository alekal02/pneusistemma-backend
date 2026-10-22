/** A visão do presidente não grava. */
export function somenteLeituraExecutiva(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ erro: 'A visão executiva é somente leitura.' });
  }
  return next();
}
