# KAI-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _KAI_user_zdotdir="${KAI_USER_ZDOTDIR:-$HOME}"
  [ -f "$_KAI_user_zdotdir/.zprofile" ] && source "$_KAI_user_zdotdir/.zprofile"
  unset _KAI_user_zdotdir
}
:
