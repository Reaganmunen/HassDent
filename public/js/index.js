// Entry point: signed in -> home page, otherwise -> login
location.replace(HD.Session.get() ? HD.config.HOME_PAGE : HD.config.LOGIN_PAGE);
